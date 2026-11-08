from decimal import Decimal

from django.db import transaction
from rest_framework import serializers

from .models import (Category, Location, Product, Receipt, ReceiptLine, Sale, SaleLine, StockCount, StockCountLine,
                     StockLevel, StockMovement, StockRequest, StockRequestLine, Supplier, Transfer, TransferLine, Variant)


class LocationSerializer(serializers.ModelSerializer):
    summary = serializers.SerializerMethodField()

    class Meta:
        model = Location
        fields = ["id", "code", "name", "kind", "is_main", "address", "phone", "color", "can_sell", "is_active", "summary"]

    def get_summary(self, obj):
        s = self.context.get("summaries", {}).get(obj.id)
        if not s:
            return None
        return {"items": s["items"], "units": str(s["units"]), "value": str(round(s["value"], 2)),
                "low": s["low"], "out": s["out"]}


class CategorySerializer(serializers.ModelSerializer):
    product_count = serializers.IntegerField(read_only=True, required=False)

    class Meta:
        model = Category
        fields = ["id", "name", "icon", "product_count"]


class VariantSerializer(serializers.ModelSerializer):
    label = serializers.CharField(read_only=True)
    options = serializers.CharField(read_only=True)
    product_name = serializers.CharField(source="product.name", read_only=True)
    unit = serializers.CharField(source="product.unit", read_only=True)
    allow_fractions = serializers.BooleanField(source="product.allow_fractions", read_only=True)
    image = serializers.ImageField(source="product.image", read_only=True)
    sku = serializers.CharField(required=False, allow_blank=True)

    class Meta:
        model = Variant
        fields = ["id", "product", "product_name", "sku", "size", "colour", "options", "label", "barcode",
                  "cost_price", "selling_price", "unit", "allow_fractions", "image", "is_active"]
        extra_kwargs = {"product": {"required": False}}


class ProductSerializer(serializers.ModelSerializer):
    variants = VariantSerializer(many=True, required=False)
    category_name = serializers.CharField(source="category.name", read_only=True, default="")
    total_stock = serializers.DecimalField(max_digits=14, decimal_places=3, read_only=True, required=False)

    class Meta:
        model = Product
        fields = ["id", "name", "code", "category", "category_name", "brand", "unit", "allow_fractions", "description",
                  "image", "reorder_level", "is_active", "variants", "total_stock"]

    @transaction.atomic
    def create(self, data):
        variants = data.pop("variants", None) or [{}]
        product = Product.objects.create(**data)
        for v in variants:
            Variant.objects.create(product=product, **v)
        return product

    @transaction.atomic
    def update(self, product, data):
        variants = data.pop("variants", None)
        product = super().update(product, data)
        if variants is not None:  # add new options; existing variants are edited via /variants/
            for v in variants:
                if not product.variants.filter(size=v.get("size", ""), colour=v.get("colour", "")).exists():
                    Variant.objects.create(product=product, **v)
        return product


class SupplierSerializer(serializers.ModelSerializer):
    total_supplied = serializers.DecimalField(max_digits=14, decimal_places=2, read_only=True, required=False)
    deliveries = serializers.IntegerField(read_only=True, required=False)

    class Meta:
        model = Supplier
        fields = ["id", "name", "contact_person", "phone", "email", "address", "kra_pin", "notes", "is_active",
                  "total_supplied", "deliveries"]


class StockLevelSerializer(serializers.ModelSerializer):
    variant = VariantSerializer(read_only=True)
    location_code = serializers.CharField(source="location.code", read_only=True)
    reorder_at = serializers.DecimalField(source="effective_reorder_level", max_digits=12, decimal_places=3, read_only=True)
    is_low = serializers.BooleanField(read_only=True)
    value = serializers.SerializerMethodField()

    class Meta:
        model = StockLevel
        fields = ["id", "location", "location_code", "variant", "quantity", "reorder_level", "reorder_at", "is_low",
                  "bin_location", "value", "updated_at"]
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
    """Validate lines: positive quantity, whole numbers unless the product allows fractions, no duplicates."""

    def validate_lines(self, lines):
        if not lines:
            raise serializers.ValidationError("Add at least one product.")
        seen = set()
        for line in lines:
            v, qty = line["variant"], line["quantity"]
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


class ReceiptSerializer(LineMixin, serializers.ModelSerializer):
    lines = ReceiptLineSerializer(many=True)
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
                  "lines", "created_by_name", "created_at", "posted_at", "post_now"]
        read_only_fields = ["code", "status", "posted_at"]

    def get_created_by_name(self, obj):
        return _person(obj.created_by)

    def create(self, data):
        lines = data.pop("lines")
        data.pop("post_now", None)
        receipt = Receipt.objects.create(**data)
        ReceiptLine.objects.bulk_create([ReceiptLine(receipt=receipt, **l) for l in lines])
        return receipt


class TransferLineSerializer(DocLineSerializer):
    shortage = serializers.DecimalField(max_digits=12, decimal_places=3, read_only=True)

    class Meta:
        model = TransferLine
        fields = ["id", "variant", "variant_label", "sku", "unit", "quantity", "received_quantity", "shortage"]
        read_only_fields = ["received_quantity"]


class TransferSerializer(LineMixin, serializers.ModelSerializer):
    lines = TransferLineSerializer(many=True)
    source_name = serializers.CharField(source="source.name", read_only=True)
    destination_name = serializers.CharField(source="destination.name", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    has_discrepancy = serializers.BooleanField(read_only=True)
    people = serializers.SerializerMethodField()

    class Meta:
        model = Transfer
        fields = ["id", "code", "client_uuid", "source", "source_name", "destination", "destination_name", "status",
                  "status_label", "notes", "lines", "has_discrepancy", "rejection_reason", "people", "created_at",
                  "approved_at", "dispatched_at", "received_at"]
        read_only_fields = ["code", "status", "rejection_reason", "approved_at", "dispatched_at", "received_at"]

    def get_people(self, obj):
        return {"requested_by": _person(obj.created_by), "approved_by": _person(obj.approved_by),
                "dispatched_by": _person(obj.dispatched_by), "received_by": _person(obj.received_by)}

    def validate(self, data):
        if data.get("source") == data.get("destination"):
            raise serializers.ValidationError("Choose two different locations.")
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


class StockRequestSerializer(LineMixin, serializers.ModelSerializer):
    lines = StockRequestLineSerializer(many=True)
    location_name = serializers.CharField(source="location.name", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    reason_label = serializers.CharField(source="get_reason_display", read_only=True)
    already_done = serializers.BooleanField(write_only=True, default=False)
    people = serializers.SerializerMethodField()

    class Meta:
        model = StockRequest
        fields = ["id", "code", "client_uuid", "kind", "location", "location_name", "reason", "reason_label", "status",
                  "status_label", "source", "raw_message", "notes", "lines", "rejection_reason", "people",
                  "created_at", "confirmed_at", "approved_at", "already_done"]
        read_only_fields = ["code", "status", "source", "raw_message", "rejection_reason", "confirmed_at", "approved_at"]

    def get_people(self, obj):
        return {"requested_by": _person(obj.created_by), "confirmed_by": _person(obj.confirmed_by),
                "approved_by": _person(obj.approved_by)}

    def create(self, data):
        lines = data.pop("lines")
        already_done = data.pop("already_done", False)
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


class SaleSerializer(LineMixin, serializers.ModelSerializer):
    lines = SaleLineSerializer(many=True)
    location_name = serializers.CharField(source="location.name", read_only=True)
    subtotal = serializers.DecimalField(max_digits=14, decimal_places=2, read_only=True)
    total = serializers.DecimalField(max_digits=14, decimal_places=2, read_only=True)
    sold_by = serializers.SerializerMethodField()

    class Meta:
        model = Sale
        fields = ["id", "code", "client_uuid", "location", "location_name", "customer_name", "customer_phone",
                  "payment_method", "payment_reference", "discount", "subtotal", "total", "status", "void_reason",
                  "notes", "lines", "sold_by", "created_at"]
        read_only_fields = ["code", "status", "void_reason"]

    def get_sold_by(self, obj):
        return _person(obj.created_by)

    def create(self, data):
        lines = data.pop("lines")
        sale = Sale.objects.create(**data)
        SaleLine.objects.bulk_create([
            SaleLine(sale=sale, unit_price=l.get("unit_price", l["variant"].selling_price),
                     **{k: v for k, v in l.items() if k != "unit_price"}) for l in lines])
        return sale


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
