from decimal import Decimal

from django.db import transaction
from rest_framework import serializers

from accounts.models import normalize_phone

from .models import (MOTOR_VEHICLES, Category, Customer, Location, MpesaPayment, Product, Receipt, ReceiptLine, Sale,
                     SaleLine, SalePayment, StockCount, StockCountLine, StockLevel, StockMovement, StockRequest,
                     StockRequestLine, Supplier, Transfer, TransferLine, Variant, Vehicle)


def _business_id(serializer):
    request = serializer.context.get("request")
    return getattr(getattr(request, "user", None), "business_id", None)


class SameBusinessMixin:
    """Refuse any store, supplier, customer or category that belongs to another business."""

    def validate(self, data):
        data = super().validate(data)
        biz = _business_id(self)
        for key, value in data.items():
            if hasattr(value, "business_id") and value.business_id != biz:
                raise serializers.ValidationError({key: "Not found in your business."})
        return data


# ----------------------------------------------------------------------------- master data
class LocationSerializer(SameBusinessMixin, serializers.ModelSerializer):
    summary = serializers.SerializerMethodField()
    code = serializers.CharField(max_length=10, required=False, allow_blank=True)
    can_sell = serializers.BooleanField(required=False)

    class Meta:
        model = Location
        fields = ["id", "code", "name", "kind", "is_main", "address", "latitude", "longitude", "phone", "color",
                  "can_sell", "is_active", "summary"]

    def get_summary(self, obj):
        s = self.context.get("summaries", {}).get(obj.id)
        if not s:
            return None
        return {"items": s["items"], "units": str(s["units"]), "value": str(round(s["value"], 2)),
                "low": s["low"], "out": s["out"]}

    def validate(self, data):
        data = super().validate(data)
        biz = _business_id(self)
        name = data.get("name", getattr(self.instance, "name", ""))
        code = (data.get("code") or "").upper().strip()
        if not code and not self.instance:
            code = suggest_code(name, Location.objects.filter(business_id=biz).values_list("code", flat=True))
        if code:
            clash = Location.objects.filter(business_id=biz, code=code).exclude(pk=getattr(self.instance, "pk", None))
            if clash.exists():
                raise serializers.ValidationError({"code": f"{code} is already used by {clash.first().name}."})
            data["code"] = code
        if "can_sell" not in data and not self.instance:
            data["can_sell"] = data.get("kind", Location.Kind.SHOP) == Location.Kind.SHOP
        lat, lng = data.get("latitude"), data.get("longitude")
        if (lat is None) != (lng is None) and ("latitude" in data or "longitude" in data):
            raise serializers.ValidationError("Give both latitude and longitude, or neither.")
        if lat is not None and not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise serializers.ValidationError("That map position is not valid.")
        return data


def suggest_code(name, taken):
    """Short store code from its name: 'Main Shop' → MAIN, 'Kitengela Godown' → KITE, plus a number if taken."""
    taken = {t.upper() for t in taken}
    words = [w for w in "".join(c if c.isalnum() else " " for c in (name or "")).upper().split() if w]
    base = (words[0][:4] if words else "STR") or "STR"
    code, n = base, 2
    while code in taken:
        code = f"{base[:8]}{n}"
        n += 1
    return code


def auto_product_code(business_id, name):
    words = [w for w in "".join(c if c.isalnum() else " " for c in (name or "")).upper().split() if w]
    base = (words[0][:4] if words else "ITEM") or "ITEM"
    code, n = base, 2
    while Product.objects.filter(business_id=business_id, code=code).exists():
        code = f"{base}{n}"
        n += 1
    return code


def category_named(business_id, name):
    """Find a category by name (any capitals) or create it: owners type their own, e.g. Taps, Tanks."""
    name = " ".join((name or "").split())
    if not name:
        return None
    found = Category.objects.filter(business_id=business_id, name__iexact=name).first()
    return found or Category.objects.create(business_id=business_id, name=name[:80])


class CategorySerializer(serializers.ModelSerializer):
    product_count = serializers.IntegerField(read_only=True, required=False)

    class Meta:
        model = Category
        fields = ["id", "name", "icon", "product_count"]

    def validate_name(self, name):
        name = name.strip()
        clash = Category.objects.filter(business_id=_business_id(self), name__iexact=name)
        if clash.exclude(pk=getattr(self.instance, "pk", None)).exists():
            raise serializers.ValidationError("You already have this category.")
        return name


class VariantSerializer(serializers.ModelSerializer):
    label = serializers.CharField(read_only=True)
    options = serializers.CharField(read_only=True)
    product_name = serializers.CharField(source="product.name", read_only=True)
    product_code = serializers.CharField(source="product.code", read_only=True)
    unit = serializers.CharField(source="product.unit", read_only=True)
    allow_fractions = serializers.BooleanField(source="product.allow_fractions", read_only=True)
    image = serializers.ImageField(source="product.image", read_only=True)
    sku = serializers.CharField(required=False, allow_blank=True)

    class Meta:
        model = Variant
        fields = ["id", "product", "product_name", "product_code", "sku", "size", "colour", "options", "label",
                  "cost_price", "selling_price", "unit", "allow_fractions", "image", "is_active"]
        extra_kwargs = {"product": {"required": False}}

    def validate(self, data):
        product = data.get("product") or getattr(self.instance, "product", None)
        if product is not None and product.business_id != _business_id(self):
            raise serializers.ValidationError({"product": "Not found in your business."})
        if data.get("selling_price", 0) < 0 or data.get("cost_price", 0) < 0:
            raise serializers.ValidationError("Prices can't be negative.")
        return data


class NewVariantSerializer(serializers.Serializer):
    size = serializers.CharField(max_length=40, required=False, allow_blank=True, default="")
    colour = serializers.CharField(max_length=40, required=False, allow_blank=True, default="")
    selling_price = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0"), required=False, default=Decimal("0"))
    cost_price = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0"), required=False, default=Decimal("0"))


class ProductSerializer(SameBusinessMixin, serializers.ModelSerializer):
    variants = VariantSerializer(many=True, read_only=True)
    new_variants = NewVariantSerializer(many=True, required=False, write_only=True,
                                        help_text="Sizes / colours to add: [{size, colour, selling_price, cost_price}]")
    code = serializers.CharField(max_length=20, required=False, allow_blank=True)
    category_name = serializers.CharField(source="category.name", read_only=True, default="")
    total_stock = serializers.DecimalField(max_digits=14, decimal_places=3, read_only=True, required=False)
    supplier_names = serializers.SerializerMethodField()
    new_category = serializers.CharField(write_only=True, required=False, allow_blank=True, max_length=80,
                                         help_text="Category typed by the user; created if it doesn't exist yet")

    class Meta:
        model = Product
        fields = ["id", "name", "code", "category", "category_name", "new_category", "brand", "unit", "allow_fractions",
                  "description", "image", "reorder_level", "suppliers", "supplier_names", "is_active", "variants",
                  "new_variants", "total_stock"]
        extra_kwargs = {"suppliers": {"required": False}}

    def get_supplier_names(self, obj):
        return [s.name for s in obj.suppliers.all()]

    def validate(self, data):
        data = super().validate(data)
        biz = _business_id(self)
        for s in data.get("suppliers", []):
            if s.business_id != biz:
                raise serializers.ValidationError({"suppliers": "Not found in your business."})
        code = (data.get("code") or "").upper().strip()
        name = data.get("name", getattr(self.instance, "name", ""))
        if not code and not self.instance:
            code = auto_product_code(biz, name)
        if code:
            clash = Product.objects.filter(business_id=biz, code=code).exclude(pk=getattr(self.instance, "pk", None))
            if clash.exists():
                raise serializers.ValidationError({"code": f"Code {code} is already used by {clash.first().name}."})
            data["code"] = code
        if data.get("reorder_level") is not None and data["reorder_level"] < 0:
            raise serializers.ValidationError({"reorder_level": "Can't be negative."})
        typed = data.pop("new_category", None)
        if typed and typed.strip():
            data["category"] = category_named(biz, typed)
        return data

    @transaction.atomic
    def create(self, data):
        variants = data.pop("new_variants", None) or [{}]
        suppliers = data.pop("suppliers", [])
        product = Product.objects.create(**data)
        product.suppliers.set(suppliers)
        self._add_variants(product, variants)
        return product

    @transaction.atomic
    def update(self, product, data):
        variants = data.pop("new_variants", None)
        product = super().update(product, data)
        if variants:
            self._add_variants(product, variants)
        return product

    @staticmethod
    def _add_variants(product, variants):
        seen = set()
        for v in variants:
            size, colour = (v.get("size") or "").strip(), (v.get("colour") or "").strip()
            if (size.lower(), colour.lower()) in seen or product.variants.filter(size__iexact=size, colour__iexact=colour).exists():
                continue
            seen.add((size.lower(), colour.lower()))
            Variant.objects.create(product=product, size=size, colour=colour,
                                   selling_price=v.get("selling_price") or 0, cost_price=v.get("cost_price") or 0)


class SupplierSerializer(serializers.ModelSerializer):
    total_supplied = serializers.DecimalField(max_digits=14, decimal_places=2, read_only=True, required=False)
    deliveries = serializers.IntegerField(read_only=True, required=False)
    product_count = serializers.IntegerField(read_only=True, required=False)
    owed = serializers.SerializerMethodField()

    class Meta:
        model = Supplier
        fields = ["id", "name", "contact_person", "phone", "email", "address", "kra_pin", "notes", "is_active",
                  "total_supplied", "deliveries", "product_count", "owed"]

    def get_owed(self, obj):
        posted = obj.receipts.filter(status="posted").prefetch_related("lines")
        return str(round(sum((r.balance_due for r in posted), Decimal(0)), 2))

    def validate_name(self, name):
        name = name.strip()
        clash = Supplier.objects.filter(business_id=_business_id(self), name__iexact=name)
        if clash.exclude(pk=getattr(self.instance, "pk", None)).exists():
            raise serializers.ValidationError("You already have a supplier with this name.")
        return name


class CustomerSerializer(serializers.ModelSerializer):
    owed = serializers.SerializerMethodField()
    overdue = serializers.SerializerMethodField()
    credit_sales = serializers.IntegerField(read_only=True, required=False)

    class Meta:
        model = Customer
        fields = ["id", "name", "phone", "credit_limit", "notes", "is_active", "owed", "overdue", "credit_sales", "created_at"]

    def _open(self, obj):
        cache = self.context.setdefault("_open_sales", {})
        if obj.pk not in cache:
            cache[obj.pk] = [s for s in obj.sales.filter(status="completed").prefetch_related("lines") if s.balance > 0]
        return cache[obj.pk]

    def get_owed(self, obj):
        return str(sum((s.balance for s in self._open(obj)), Decimal(0)))

    def get_overdue(self, obj):
        from django.utils import timezone

        today = timezone.localdate()
        return str(sum((s.balance for s in self._open(obj) if s.due_date and s.due_date < today), Decimal(0)))

    def validate_phone(self, phone):
        phone = normalize_phone(phone)
        if phone:
            clash = Customer.objects.filter(business_id=_business_id(self), phone=phone)
            if clash.exclude(pk=getattr(self.instance, "pk", None)).exists():
                raise serializers.ValidationError(f"This phone belongs to {clash.first().name}.")
        return phone


class StockLevelSerializer(serializers.ModelSerializer):
    variant = VariantSerializer(read_only=True)
    location_code = serializers.CharField(source="location.code", read_only=True)
    location_name = serializers.CharField(source="location.name", read_only=True)
    reorder_at = serializers.DecimalField(source="effective_reorder_level", max_digits=12, decimal_places=3, read_only=True)
    is_low = serializers.BooleanField(read_only=True)
    state = serializers.CharField(read_only=True)
    value = serializers.SerializerMethodField()

    class Meta:
        model = StockLevel
        fields = ["id", "location", "location_code", "location_name", "variant", "quantity", "reorder_level", "reorder_at",
                  "is_low", "state", "bin_location", "value", "updated_at"]
        read_only_fields = ["location", "quantity"]

    def get_value(self, obj):
        return str(round(obj.quantity * obj.variant.cost_price, 2))


class MovementSerializer(serializers.ModelSerializer):
    variant_label = serializers.CharField(source="variant.label", read_only=True)
    sku = serializers.CharField(source="variant.sku", read_only=True)
    location_code = serializers.CharField(source="location.code", read_only=True)
    kind_label = serializers.CharField(source="get_kind_display", read_only=True)
    user_name = serializers.SerializerMethodField()

    class Meta:
        model = StockMovement
        fields = ["id", "location", "location_code", "variant", "variant_label", "sku", "kind", "kind_label",
                  "quantity", "balance_after", "unit_cost", "reference", "note", "user_name", "created_at"]

    def get_user_name(self, obj):
        return obj.user.get_full_name() or obj.user.username if obj.user else "System"


# ----------------------------------------------------------------------------- documents
def _person(user):
    return (user.get_full_name() or user.username) if user else None


class LineMixin:
    """Validate lines: positive quantity, whole numbers unless the product allows fractions, no duplicates,
    and only products from the user's own catalogue."""

    def validate_lines(self, lines):
        if not lines:
            raise serializers.ValidationError("Add at least one product.")
        biz = _business_id(self)
        seen = set()
        for line in lines:
            v, qty = line["variant"], line["quantity"]
            if v.product.business_id != biz:
                raise serializers.ValidationError("That product isn't in your catalogue.")
            if v.id in seen:
                raise serializers.ValidationError(f"{v.label} is listed twice. Combine the quantities.")
            seen.add(v.id)
            if qty <= 0:
                raise serializers.ValidationError(f"Quantity for {v.label} must be more than zero.")
            if not v.product.allow_fractions and qty != qty.to_integral_value():
                raise serializers.ValidationError(f"{v.label} is counted in whole {v.product.unit}.")
        return lines


class DocLineSerializer(serializers.ModelSerializer):
    variant_label = serializers.CharField(source="variant.label", read_only=True)
    sku = serializers.CharField(source="variant.sku", read_only=True)
    unit = serializers.CharField(source="variant.product.unit", read_only=True)


class ReceiptLineSerializer(DocLineSerializer):
    class Meta:
        model = ReceiptLine
        fields = ["id", "variant", "variant_label", "sku", "unit", "quantity", "unit_cost"]


class TypedProductLine(serializers.Serializer):
    """A product typed in while receiving a delivery. Saved to the catalogue so it can be picked next time."""

    name = serializers.CharField(max_length=150)
    size = serializers.CharField(max_length=40, required=False, allow_blank=True, default="")
    colour = serializers.CharField(max_length=40, required=False, allow_blank=True, default="")
    unit = serializers.ChoiceField(choices=Product.Unit.choices, default=Product.Unit.PCS)
    category = serializers.CharField(max_length=80, required=False, allow_blank=True, default="")
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3, min_value=Decimal("0.001"))
    unit_cost = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0"))
    selling_price = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0"), required=False,
                                             default=Decimal("0"))


class ReceiptSerializer(SameBusinessMixin, LineMixin, serializers.ModelSerializer):
    lines = ReceiptLineSerializer(many=True, required=False)
    new_products = TypedProductLine(many=True, required=False, write_only=True)
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    location_name = serializers.CharField(source="location.name", read_only=True)
    total_amount = serializers.DecimalField(max_digits=14, decimal_places=2, read_only=True)
    balance_due = serializers.DecimalField(max_digits=14, decimal_places=2, read_only=True)
    payment_status = serializers.CharField(read_only=True)
    created_by_name = serializers.SerializerMethodField()
    post_now = serializers.BooleanField(write_only=True, default=True)

    class Meta:
        model = Receipt
        fields = ["id", "code", "client_uuid", "location", "location_name", "supplier", "supplier_name", "supplied_on",
                  "invoice_number", "status", "amount_paid", "total_amount", "balance_due", "payment_status", "notes",
                  "lines", "new_products", "created_by_name", "created_at", "posted_at", "post_now"]
        read_only_fields = ["code", "status", "posted_at"]

    def validate_lines(self, lines):
        return super().validate_lines(lines) if lines else lines

    def validate(self, data):
        data = super().validate(data)
        if not data.get("lines") and not data.get("new_products"):
            raise serializers.ValidationError("Add at least one product.")
        keys = [(p["name"].strip().lower(), p["size"].strip().lower(), p["colour"].strip().lower())
                for p in data.get("new_products", [])]
        if len(set(keys)) != len(keys):
            raise serializers.ValidationError("The same new product is typed twice. Combine the quantities.")
        return data

    def get_created_by_name(self, obj):
        return _person(obj.created_by)

    def validate_amount_paid(self, v):
        if v < 0:
            raise serializers.ValidationError("Can't be negative.")
        return v

    def create(self, data):
        lines = list(data.pop("lines", []))
        typed = data.pop("new_products", [])
        data.pop("post_now", None)
        biz = data["location"].business_id
        taken = {l["variant"].id for l in lines}
        for p in typed:
            variant = self._catalogue_variant(biz, p)
            if variant.id in taken:
                raise serializers.ValidationError(f"{variant.label} is listed twice. Combine the quantities.")
            taken.add(variant.id)
            lines.append({"variant": variant, "quantity": p["quantity"], "unit_cost": p["unit_cost"]})
        receipt = Receipt.objects.create(**data)
        ReceiptLine.objects.bulk_create([ReceiptLine(receipt=receipt, **l) for l in lines])
        return receipt

    @staticmethod
    def _catalogue_variant(biz, p):
        """Find the typed product (same name, size and colour) or add it to the catalogue."""
        name = " ".join(p["name"].split())
        size, colour = p["size"].strip(), p["colour"].strip()
        product = Product.objects.filter(business_id=biz, name__iexact=name).first()
        if product is None:
            product = Product.objects.create(
                business_id=biz, name=name, code=auto_product_code(biz, name), unit=p["unit"],
                allow_fractions=p["unit"] in ("kg", "m", "ft", "l"), category=category_named(biz, p["category"]))
        elif p["category"] and product.category_id is None:
            product.category = category_named(biz, p["category"])
            product.save(update_fields=["category", "updated_at"])
        if not product.is_active:
            product.is_active = True
            product.save(update_fields=["is_active", "updated_at"])
        variant = product.variants.filter(size__iexact=size, colour__iexact=colour).first()
        if variant is None:
            variant = Variant.objects.create(product=product, size=size, colour=colour, selling_price=p["selling_price"])
        else:
            changed = []
            if p["selling_price"] and p["selling_price"] != variant.selling_price:
                variant.selling_price = p["selling_price"]
                changed.append("selling_price")
            if not variant.is_active:
                variant.is_active = True
                changed.append("is_active")
            if changed:
                variant.save(update_fields=changed + ["updated_at"])
        if not product.allow_fractions and p["quantity"] != p["quantity"].to_integral_value():
            raise serializers.ValidationError(f"{variant.label} is counted in whole {product.unit}.")
        return variant


class TransferLineSerializer(DocLineSerializer):
    shortage = serializers.DecimalField(max_digits=12, decimal_places=3, read_only=True)

    class Meta:
        model = TransferLine
        fields = ["id", "variant", "variant_label", "sku", "unit", "quantity", "received_quantity", "shortage"]
        read_only_fields = ["received_quantity"]


class TransferSerializer(SameBusinessMixin, LineMixin, serializers.ModelSerializer):
    lines = TransferLineSerializer(many=True)
    source_name = serializers.CharField(source="source.name", read_only=True)
    destination_name = serializers.CharField(source="destination.name", read_only=True)
    source_kind = serializers.CharField(source="source.kind", read_only=True)
    destination_kind = serializers.CharField(source="destination.kind", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    vehicle_label = serializers.CharField(source="get_vehicle_type_display", read_only=True)
    has_discrepancy = serializers.BooleanField(read_only=True)
    people = serializers.SerializerMethodField()
    last_seen = serializers.SerializerMethodField()
    driver_link = serializers.SerializerMethodField()
    vehicle_type = serializers.ChoiceField(choices=Vehicle.choices, required=False, allow_blank=True)

    class Meta:
        model = Transfer
        fields = ["id", "code", "client_uuid", "source", "source_name", "source_kind", "destination", "destination_name",
                  "destination_kind", "status", "status_label", "notes", "lines", "has_discrepancy", "rejection_reason",
                  "people", "created_at", "approved_at", "dispatched_at", "received_at", "driver_name", "driver_phone",
                  "vehicle_type", "vehicle_label", "vehicle_reg", "tracking_token", "driver_link", "arrived_near_at", "last_seen"]
        read_only_fields = ["code", "status", "rejection_reason", "approved_at", "dispatched_at", "received_at",
                            "tracking_token", "arrived_near_at"]

    def get_people(self, obj):
        return {"requested_by": _person(obj.created_by), "approved_by": _person(obj.approved_by),
                "dispatched_by": _person(obj.dispatched_by), "received_by": _person(obj.received_by)}

    def get_driver_link(self, obj):
        request = self.context.get("request")
        if not obj.tracking_token or request is None:
            return None
        from .views import tracking_link

        return tracking_link(request, obj)

    def get_last_seen(self, obj):
        p = obj.track_points.order_by("-recorded_at").first() if obj.status == "in_transit" else None
        return {"lat": p.latitude, "lng": p.longitude, "at": p.recorded_at} if p else None

    def validate(self, data):
        data = super().validate(data)
        if data.get("source") == data.get("destination"):
            raise serializers.ValidationError("Choose two different stores.")
        vt = data.get("vehicle_type")
        if vt in MOTOR_VEHICLES and data.get("vehicle_reg") is not None and 0 < len(data["vehicle_reg"].replace(" ", "")) < 5:
            raise serializers.ValidationError({"vehicle_reg": "That number plate looks too short."})
        return data

    def create(self, data):
        lines = data.pop("lines")
        transfer = Transfer(**data)
        from .services import create_transfer_status

        create_transfer_status(transfer, data["created_by"])
        transfer.save()
        TransferLine.objects.bulk_create([TransferLine(transfer=transfer, **l) for l in lines])
        return transfer


class StockRequestLineSerializer(DocLineSerializer):
    final_quantity = serializers.DecimalField(max_digits=12, decimal_places=3, read_only=True)

    class Meta:
        model = StockRequestLine
        fields = ["id", "variant", "variant_label", "sku", "unit", "quantity", "confirmed_quantity", "final_quantity"]
        read_only_fields = ["confirmed_quantity"]


class StockRequestSerializer(SameBusinessMixin, LineMixin, serializers.ModelSerializer):
    lines = StockRequestLineSerializer(many=True)
    location_name = serializers.CharField(source="location.name", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    reason_label = serializers.CharField(source="get_reason_display", read_only=True)
    already_done = serializers.BooleanField(write_only=True, default=False)
    apply_now = serializers.BooleanField(write_only=True, default=False,
                                         help_text="Admin only: record and approve in one step (goods already moved)")
    people = serializers.SerializerMethodField()
    value = serializers.SerializerMethodField()

    class Meta:
        model = StockRequest
        fields = ["id", "code", "client_uuid", "kind", "location", "location_name", "reason", "reason_label", "status",
                  "status_label", "source", "raw_message", "notes", "lines", "rejection_reason", "people", "value",
                  "created_at", "confirmed_at", "approved_at", "already_done", "apply_now"]
        read_only_fields = ["code", "status", "source", "raw_message", "rejection_reason", "confirmed_at", "approved_at"]

    def get_people(self, obj):
        return {"requested_by": _person(obj.created_by), "confirmed_by": _person(obj.confirmed_by),
                "approved_by": _person(obj.approved_by)}

    def get_value(self, obj):
        """Value at cost of what is being removed / added, so the admin sees the money involved."""
        return str(round(sum((l.final_quantity * l.variant.cost_price for l in obj.lines.all()), Decimal(0)), 2))

    def create(self, data):
        lines = data.pop("lines")
        already_done = data.pop("already_done", False)
        data.pop("apply_now", None)
        req = StockRequest(**data)
        from .services import initial_request_status

        initial_request_status(req, data["created_by"], already_done=already_done)
        req.save()
        confirmed = req.status == StockRequest.Status.CONFIRMED
        StockRequestLine.objects.bulk_create([
            StockRequestLine(request=req, confirmed_quantity=l["quantity"] if confirmed else None, **l) for l in lines])
        return req


class SaleLineSerializer(DocLineSerializer):
    class Meta:
        model = SaleLine
        fields = ["id", "variant", "variant_label", "sku", "unit", "quantity", "unit_price"]
        extra_kwargs = {"unit_price": {"required": False}}


class SalePaymentSerializer(serializers.ModelSerializer):
    method_label = serializers.CharField(source="get_method_display", read_only=True)
    received_by_name = serializers.SerializerMethodField()

    class Meta:
        model = SalePayment
        fields = ["id", "amount", "method", "method_label", "reference", "received_by_name", "created_at"]

    def get_received_by_name(self, obj):
        return _person(obj.received_by)


class SaleSerializer(SameBusinessMixin, LineMixin, serializers.ModelSerializer):
    lines = SaleLineSerializer(many=True)
    payments = SalePaymentSerializer(many=True, read_only=True)
    location_name = serializers.CharField(source="location.name", read_only=True)
    subtotal = serializers.DecimalField(max_digits=14, decimal_places=2, read_only=True)
    total = serializers.DecimalField(max_digits=14, decimal_places=2, read_only=True)
    balance = serializers.DecimalField(max_digits=14, decimal_places=2, read_only=True)
    payment_status = serializers.CharField(read_only=True)
    sold_by = serializers.SerializerMethodField()
    deposit = serializers.DecimalField(max_digits=14, decimal_places=2, write_only=True, required=False,
                                       min_value=Decimal("0"), help_text="Credit sales: money paid now")
    mpesa_payment = serializers.IntegerField(write_only=True, required=False, allow_null=True,
                                             help_text="Id of a paid M-Pesa prompt (instead of typing the code)")

    class Meta:
        model = Sale
        fields = ["id", "code", "client_uuid", "location", "location_name", "customer", "customer_name", "customer_phone",
                  "payment_method", "payment_reference", "discount", "subtotal", "total", "amount_paid", "balance",
                  "payment_status", "due_date", "status", "void_reason", "notes", "lines", "payments", "sold_by",
                  "created_at", "deposit", "mpesa_payment"]
        read_only_fields = ["code", "status", "void_reason", "amount_paid"]

    def get_sold_by(self, obj):
        return _person(obj.created_by)

    def validate(self, data):
        data = super().validate(data)
        if data.get("discount", 0) < 0:
            raise serializers.ValidationError({"discount": "Can't be negative."})
        name = (data.get("customer_name") or "").strip()
        phone = normalize_phone(data.get("customer_phone") or "")
        if data.get("payment_method") == Sale.Payment.CREDIT and not data.get("customer"):
            if not name or len(phone) < 12:
                raise serializers.ValidationError("Credit sales need the customer's name and phone number.")
        data["customer_name"], data["customer_phone"] = name, phone
        return data

    def create(self, data):
        lines = data.pop("lines")
        data.pop("deposit", None)
        data.pop("mpesa_payment", None)
        customer = data.get("customer")
        if customer is None and data["customer_phone"] and data["customer_name"]:
            customer, _ = Customer.objects.get_or_create(
                business_id=data["location"].business_id, phone=data["customer_phone"],
                defaults={"name": data["customer_name"]})
            data["customer"] = customer
        if customer is not None:
            data["customer_name"] = data["customer_name"] or customer.name
            data["customer_phone"] = data["customer_phone"] or customer.phone
        sale = Sale.objects.create(**data)
        SaleLine.objects.bulk_create([
            SaleLine(sale=sale, unit_price=l.get("unit_price", l["variant"].selling_price),
                     **{k: v for k, v in l.items() if k != "unit_price"}) for l in lines])
        return sale


class MpesaPaymentSerializer(serializers.ModelSerializer):
    status_label = serializers.CharField(source="get_status_display", read_only=True)

    class Meta:
        model = MpesaPayment
        fields = ["id", "phone", "amount", "status", "status_label", "result_desc", "receipt_number", "sale", "created_at"]


class CountLineSerializer(DocLineSerializer):
    variance = serializers.DecimalField(max_digits=12, decimal_places=3, read_only=True)

    class Meta:
        model = StockCountLine
        fields = ["id", "variant", "variant_label", "sku", "unit", "expected", "counted", "variance"]
        read_only_fields = ["variant", "expected"]


class StockCountSerializer(serializers.ModelSerializer):
    lines = CountLineSerializer(many=True, read_only=True)
    location_name = serializers.CharField(source="location.name", read_only=True)
    progress = serializers.SerializerMethodField()

    class Meta:
        model = StockCount
        fields = ["id", "code", "location", "location_name", "status", "notes", "lines", "progress", "created_at", "posted_at"]
        read_only_fields = ["code", "status", "posted_at"]

    def get_progress(self, obj):
        lines = list(obj.lines.all())
        done = sum(1 for l in lines if l.counted is not None)
        return {"counted": done, "total": len(lines), "differences": sum(1 for l in lines if l.variance)}


class QuantityMapSerializer(serializers.Serializer):
    """{"quantities": {"<line id>": "9"}, "reason": "..."} used by confirm / receive / reject actions."""

    quantities = serializers.DictField(child=serializers.DecimalField(max_digits=12, decimal_places=3, min_value=Decimal("0")),
                                       required=False)
    reason = serializers.CharField(required=False, allow_blank=True, max_length=255)
