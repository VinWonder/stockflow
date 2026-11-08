"""
StockFlow data model.

Golden rule: StockLevel.quantity is NEVER edited by hand. Every change goes through
inventory.services.apply_movement(), which writes an immutable StockMovement (the ledger)
and updates the cached balance inside one locked database transaction.
"""
from decimal import Decimal

from django.conf import settings
from django.db import models


QTY = dict(max_digits=12, decimal_places=3)
MONEY = dict(max_digits=14, decimal_places=2)
ZERO = Decimal("0")


class TimeStamped(models.Model):
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


# ----------------------------------------------------------------------------- places
class Location(TimeStamped):
    class Kind(models.TextChoices):
        GODOWN = "godown", "Godown / store"
        SHOP = "shop", "Shop"

    code = models.CharField(max_length=10, unique=True, help_text="Short code used in SMS, e.g. GDN, SHP1")
    name = models.CharField(max_length=100)
    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.SHOP)
    is_main = models.BooleanField(default=False, help_text="The main shop (only one)")
    address = models.CharField(max_length=200, blank=True)
    phone = models.CharField(max_length=20, blank=True)
    color = models.CharField(max_length=7, default="#2563EB", help_text="Card colour in the app")
    can_sell = models.BooleanField(default=True, help_text="Sales can be recorded here")
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["-is_main", "kind", "name"]

    def __str__(self):
        return f"{self.name} ({self.code})"

    def save(self, *args, **kwargs):
        self.code = self.code.upper().strip()
        if self.kind == self.Kind.GODOWN and not self.pk:
            self.can_sell = False
        super().save(*args, **kwargs)
        if self.is_main:
            Location.objects.exclude(pk=self.pk).filter(is_main=True).update(is_main=False)


# ----------------------------------------------------------------------------- catalogue
class Category(models.Model):
    name = models.CharField(max_length=80, unique=True)
    icon = models.CharField(max_length=40, default="category", help_text="Material icon name for the app")

    class Meta:
        ordering = ["name"]
        verbose_name_plural = "categories"

    def __str__(self):
        return self.name


class Product(TimeStamped):
    class Unit(models.TextChoices):
        PCS = "pcs", "Pieces"
        BAG = "bag", "Bags"
        KG = "kg", "Kilograms"
        M = "m", "Metres"
        FT = "ft", "Feet"
        L = "l", "Litres"
        BOX = "box", "Boxes"
        ROLL = "roll", "Rolls"
        SHEET = "sheet", "Sheets"
        SET = "set", "Sets"
        PAIR = "pair", "Pairs"
        TIN = "tin", "Tins"

    name = models.CharField(max_length=150)
    code = models.CharField(max_length=20, unique=True, help_text="Short product code used in SMS, e.g. CEM, PNT")
    category = models.ForeignKey(Category, null=True, blank=True, on_delete=models.SET_NULL, related_name="products")
    brand = models.CharField(max_length=80, blank=True)
    unit = models.CharField(max_length=10, choices=Unit.choices, default=Unit.PCS)
    allow_fractions = models.BooleanField(default=False, help_text="Allow quantities like 2.5 (kg, m, l)")
    description = models.TextField(blank=True)
    image = models.ImageField(upload_to="products/", blank=True)
    reorder_level = models.DecimalField(**QTY, default=Decimal("5"), help_text="Warn when stock falls to this")
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        self.code = self.code.upper().strip()
        super().save(*args, **kwargs)


class Variant(TimeStamped):
    """A stockable item: one product in one size/colour. Products without options get one default variant."""

    product = models.ForeignKey(Product, related_name="variants", on_delete=models.CASCADE)
    sku = models.CharField(max_length=40, unique=True, help_text="e.g. PNT-4L-WHT. Auto-built if left blank.")
    size = models.CharField(max_length=40, blank=True)
    colour = models.CharField(max_length=40, blank=True)
    barcode = models.CharField(max_length=64, unique=True, null=True, blank=True)
    cost_price = models.DecimalField(**MONEY, default=ZERO, help_text="Weighted average buying price")
    selling_price = models.DecimalField(**MONEY, default=ZERO)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["product__name", "size", "colour"]
        constraints = [models.UniqueConstraint(fields=["product", "size", "colour"], name="unique_variant_options")]

    def __str__(self):
        return self.label

    @property
    def options(self):
        return " / ".join(x for x in [self.size, self.colour] if x)

    @property
    def label(self):
        return f"{self.product.name}{' — ' + self.options if self.options else ''}"

    def save(self, *args, **kwargs):
        if not self.sku:
            parts = [self.product.code] + [p.replace(" ", "")[:6] for p in (self.size, self.colour) if p]
            self.sku = "-".join(parts)
        self.sku = self.sku.upper().strip()
        self.barcode = self.barcode or None
        super().save(*args, **kwargs)


class Supplier(TimeStamped):
    name = models.CharField(max_length=150)
    contact_person = models.CharField(max_length=100, blank=True)
    phone = models.CharField(max_length=20, blank=True)
    email = models.EmailField(blank=True)
    address = models.CharField(max_length=200, blank=True)
    kra_pin = models.CharField("KRA PIN", max_length=20, blank=True)
    notes = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


# ----------------------------------------------------------------------------- stock
class StockLevel(models.Model):
    """Cached balance per location + variant. Only services.apply_movement() writes quantity."""

    location = models.ForeignKey(Location, related_name="levels", on_delete=models.CASCADE)
    variant = models.ForeignKey(Variant, related_name="levels", on_delete=models.CASCADE)
    quantity = models.DecimalField(**QTY, default=ZERO)
    reorder_level = models.DecimalField(**QTY, null=True, blank=True, help_text="Overrides the product's level here")
    bin_location = models.CharField(max_length=40, blank=True, help_text="Shelf / row, e.g. A3")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["location", "variant"], name="one_level_per_location_variant"),
            models.CheckConstraint(condition=models.Q(quantity__gte=0), name="stock_never_negative"),
        ]
        indexes = [models.Index(fields=["location", "quantity"])]

    def __str__(self):
        return f"{self.variant} @ {self.location.code}: {self.quantity}"

    @property
    def effective_reorder_level(self):
        return self.reorder_level if self.reorder_level is not None else self.variant.product.reorder_level

    @property
    def is_low(self):
        return self.quantity <= self.effective_reorder_level


class StockMovement(models.Model):
    """Immutable ledger line. Positive quantity = stock in, negative = stock out."""

    class Kind(models.TextChoices):
        RECEIPT = "receipt", "Supplier delivery"
        TRANSFER_OUT = "transfer_out", "Transfer out"
        TRANSFER_IN = "transfer_in", "Transfer in"
        SALE = "sale", "Sale"
        SALE_VOID = "sale_void", "Sale reversed"
        REMOVAL = "removal", "Approved removal"
        ADDITION = "addition", "Approved addition"
        COUNT = "count", "Stocktake correction"
        RECEIPT_VOID = "receipt_void", "Delivery reversed"

    location = models.ForeignKey(Location, related_name="movements", on_delete=models.PROTECT)
    variant = models.ForeignKey(Variant, related_name="movements", on_delete=models.PROTECT)
    kind = models.CharField(max_length=15, choices=Kind.choices, db_index=True)
    quantity = models.DecimalField(**QTY)
    balance_after = models.DecimalField(**QTY)
    unit_cost = models.DecimalField(**MONEY, default=ZERO)
    reference = models.CharField(max_length=30, db_index=True, help_text="Document code, e.g. TRF-00012")
    note = models.CharField(max_length=255, blank=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["location", "variant", "-created_at"])]

    def __str__(self):
        return f"{self.reference} {self.variant.sku} {self.quantity:+}"

    def save(self, *args, **kwargs):
        if self.pk:
            raise ValueError("Stock movements are permanent and cannot be edited.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValueError("Stock movements are permanent and cannot be deleted.")


# ----------------------------------------------------------------------------- documents
class Document(TimeStamped):
    PREFIX = "DOC"
    code = models.CharField(max_length=20, unique=True, editable=False, null=True)
    client_uuid = models.UUIDField(null=True, blank=True, unique=True,
                                   help_text="Sent by the app so a retried request never creates a duplicate")
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    notes = models.TextField(blank=True)

    class Meta:
        abstract = True
        ordering = ["-created_at"]

    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)
        if not self.code:
            self.code = f"{self.PREFIX}{self.pk:05d}"
            type(self).objects.filter(pk=self.pk).update(code=self.code)

    def __str__(self):
        return self.code or self.PREFIX


class Receipt(Document):
    """Goods received from a supplier (GRN)."""

    PREFIX = "GRN"

    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        POSTED = "posted", "Received into stock"
        VOID = "void", "Voided"

    location = models.ForeignKey(Location, related_name="receipts", on_delete=models.PROTECT)
    supplier = models.ForeignKey(Supplier, related_name="receipts", on_delete=models.PROTECT)
    supplied_on = models.DateField()
    invoice_number = models.CharField(max_length=50, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT, db_index=True)
    amount_paid = models.DecimalField(**MONEY, default=ZERO)
    posted_at = models.DateTimeField(null=True, blank=True)

    @property
    def total_amount(self):
        return sum((l.quantity * l.unit_cost for l in self.lines.all()), ZERO)

    @property
    def balance_due(self):
        return self.total_amount - self.amount_paid

    @property
    def payment_status(self):
        if self.amount_paid <= 0:
            return "unpaid"
        return "paid" if self.amount_paid >= self.total_amount else "partial"


class ReceiptLine(models.Model):
    receipt = models.ForeignKey(Receipt, related_name="lines", on_delete=models.CASCADE)
    variant = models.ForeignKey(Variant, on_delete=models.PROTECT)
    quantity = models.DecimalField(**QTY)
    unit_cost = models.DecimalField(**MONEY, default=ZERO)


class Transfer(Document):
    """Move stock between godown and shops: request → approve → dispatch (leaves source) → receive (arrives)."""

    PREFIX = "TRF"

    class Status(models.TextChoices):
        REQUESTED = "requested", "Awaiting approval"
        APPROVED = "approved", "Approved — ready to dispatch"
        IN_TRANSIT = "in_transit", "In transit"
        RECEIVED = "received", "Received"
        REJECTED = "rejected", "Rejected"
        CANCELLED = "cancelled", "Cancelled"

    source = models.ForeignKey(Location, related_name="transfers_out", on_delete=models.PROTECT)
    destination = models.ForeignKey(Location, related_name="transfers_in", on_delete=models.PROTECT)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.REQUESTED, db_index=True)
    approved_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    approved_at = models.DateTimeField(null=True, blank=True)
    dispatched_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    dispatched_at = models.DateTimeField(null=True, blank=True)
    received_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    received_at = models.DateTimeField(null=True, blank=True)
    rejection_reason = models.CharField(max_length=255, blank=True)

    @property
    def has_discrepancy(self):
        return any(l.shortage for l in self.lines.all())


class TransferLine(models.Model):
    transfer = models.ForeignKey(Transfer, related_name="lines", on_delete=models.CASCADE)
    variant = models.ForeignKey(Variant, on_delete=models.PROTECT)
    quantity = models.DecimalField(**QTY)
    received_quantity = models.DecimalField(**QTY, null=True, blank=True)

    @property
    def shortage(self):
        if self.received_quantity is None:
            return ZERO
        return max(ZERO, self.quantity - self.received_quantity)


class StockRequest(Document):
    """
    Removal / addition that needs proof and approval.
      PENDING   → someone asked for it (admin in app, or manager by SMS/WhatsApp "REMOVE …")
      CONFIRMED → the stock manager says the goods were physically removed/added (with actual quantities)
      APPROVED  → the admin approves; only now does stock change (REMOVAL / ADDITION movements)
    """

    PREFIX = "SR"

    class Kind(models.TextChoices):
        REMOVE = "remove", "Remove stock"
        ADD = "add", "Add stock"

    class Status(models.TextChoices):
        PENDING = "pending", "Waiting for stock manager"
        CONFIRMED = "confirmed", "Done — waiting for admin approval"
        APPROVED = "approved", "Approved — stock updated"
        REJECTED = "rejected", "Rejected"
        CANCELLED = "cancelled", "Cancelled"

    class Reason(models.TextChoices):
        CUSTOMER_PICKUP = "customer_pickup", "Customer pick-up / delivery"
        DAMAGED = "damaged", "Damaged"
        EXPIRED = "expired", "Expired / spoilt"
        RETURN_SUPPLIER = "return_supplier", "Returned to supplier"
        INTERNAL_USE = "internal_use", "Used on site / internal"
        LOST = "lost", "Lost / stolen"
        FOUND = "found", "Found during check"
        CUSTOMER_RETURN = "customer_return", "Customer return"
        CORRECTION = "correction", "Correction"
        OTHER = "other", "Other"

    class Source(models.TextChoices):
        APP = "app", "App"
        SMS = "sms", "SMS"
        WHATSAPP = "whatsapp", "WhatsApp"

    kind = models.CharField(max_length=6, choices=Kind.choices)
    location = models.ForeignKey(Location, related_name="stock_requests", on_delete=models.PROTECT)
    reason = models.CharField(max_length=20, choices=Reason.choices, default=Reason.OTHER)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING, db_index=True)
    source = models.CharField(max_length=10, choices=Source.choices, default=Source.APP)
    raw_message = models.TextField(blank=True)
    sender_phone = models.CharField(max_length=15, blank=True)
    confirmed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    confirmed_at = models.DateTimeField(null=True, blank=True)
    approved_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    approved_at = models.DateTimeField(null=True, blank=True)
    rejection_reason = models.CharField(max_length=255, blank=True)


class StockRequestLine(models.Model):
    request = models.ForeignKey(StockRequest, related_name="lines", on_delete=models.CASCADE)
    variant = models.ForeignKey(Variant, on_delete=models.PROTECT)
    quantity = models.DecimalField(**QTY, help_text="Quantity asked for")
    confirmed_quantity = models.DecimalField(**QTY, null=True, blank=True, help_text="Quantity actually moved")

    @property
    def final_quantity(self):
        return self.confirmed_quantity if self.confirmed_quantity is not None else self.quantity


class Sale(Document):
    PREFIX = "SAL"

    class Payment(models.TextChoices):
        CASH = "cash", "Cash"
        MPESA = "mpesa", "M-Pesa"
        CARD = "card", "Card"
        BANK = "bank", "Bank"
        CREDIT = "credit", "Credit (pay later)"

    class Status(models.TextChoices):
        COMPLETED = "completed", "Completed"
        VOID = "void", "Voided"

    location = models.ForeignKey(Location, related_name="sales", on_delete=models.PROTECT)
    customer_name = models.CharField(max_length=120, blank=True)
    customer_phone = models.CharField(max_length=20, blank=True)
    payment_method = models.CharField(max_length=10, choices=Payment.choices, default=Payment.CASH)
    payment_reference = models.CharField(max_length=40, blank=True, help_text="M-Pesa code etc.")
    discount = models.DecimalField(**MONEY, default=ZERO)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.COMPLETED, db_index=True)
    void_reason = models.CharField(max_length=255, blank=True)

    @property
    def subtotal(self):
        return sum((l.quantity * l.unit_price for l in self.lines.all()), ZERO)

    @property
    def total(self):
        return self.subtotal - self.discount


class SaleLine(models.Model):
    sale = models.ForeignKey(Sale, related_name="lines", on_delete=models.CASCADE)
    variant = models.ForeignKey(Variant, on_delete=models.PROTECT)
    quantity = models.DecimalField(**QTY)
    unit_price = models.DecimalField(**MONEY)
    unit_cost = models.DecimalField(**MONEY, default=ZERO, help_text="Cost at time of sale, for profit")


class StockCount(Document):
    """Physical stocktake. Posting corrects the system to what was counted."""

    PREFIX = "CNT"

    class Status(models.TextChoices):
        OPEN = "open", "Counting"
        SUBMITTED = "submitted", "Submitted for approval"
        POSTED = "posted", "Posted"
        CANCELLED = "cancelled", "Cancelled"

    location = models.ForeignKey(Location, related_name="counts", on_delete=models.PROTECT)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.OPEN, db_index=True)
    posted_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    posted_at = models.DateTimeField(null=True, blank=True)


class StockCountLine(models.Model):
    count = models.ForeignKey(StockCount, related_name="lines", on_delete=models.CASCADE)
    variant = models.ForeignKey(Variant, on_delete=models.PROTECT)
    expected = models.DecimalField(**QTY, default=ZERO, help_text="System quantity when counted")
    counted = models.DecimalField(**QTY, null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["count", "variant"], name="one_line_per_variant_per_count")]

    @property
    def variance(self):
        return None if self.counted is None else self.counted - self.expected
