from django.contrib import admin

from .models import (Category, Location, Product, Receipt, ReceiptLine, Sale, SaleLine, StockCount, StockLevel,
                     StockMovement, StockRequest, StockRequestLine, Supplier, Transfer, TransferLine, Variant)


@admin.register(Location)
class LocationAdmin(admin.ModelAdmin):
    list_display = ["code", "name", "kind", "is_main", "can_sell", "is_active"]


admin.site.register(Category)


class VariantInline(admin.TabularInline):
    model = Variant
    extra = 1
    fields = ["sku", "size", "colour", "barcode", "cost_price", "selling_price", "is_active"]


@admin.register(Product)
class ProductAdmin(admin.ModelAdmin):
    list_display = ["name", "code", "category", "brand", "unit", "is_active"]
    list_filter = ["category", "unit", "is_active"]
    search_fields = ["name", "code", "variants__sku"]
    inlines = [VariantInline]


@admin.register(Supplier)
class SupplierAdmin(admin.ModelAdmin):
    list_display = ["name", "contact_person", "phone", "is_active"]
    search_fields = ["name", "phone"]


@admin.register(StockLevel)
class StockLevelAdmin(admin.ModelAdmin):
    list_display = ["variant", "location", "quantity", "reorder_level", "bin_location"]
    list_filter = ["location"]
    search_fields = ["variant__sku", "variant__product__name"]
    readonly_fields = ["quantity"]  # only the ledger changes quantity


@admin.register(StockMovement)
class StockMovementAdmin(admin.ModelAdmin):
    list_display = ["created_at", "reference", "location", "variant", "kind", "quantity", "balance_after", "user"]
    list_filter = ["kind", "location"]
    search_fields = ["reference", "variant__sku"]

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def has_add_permission(self, request):
        return False


def _readonly_doc(model, line_model, extra_list=()):
    class LineInline(admin.TabularInline):
        extra = 0
        can_delete = False

        def has_change_permission(self, request, obj=None):
            return False

    LineInline.model = line_model

    class DocAdmin(admin.ModelAdmin):
        list_display = ["code", "created_at", "status", *extra_list]
        list_filter = ["status"]
        search_fields = ["code"]
        inlines = [LineInline]

        def get_readonly_fields(self, request, obj=None):
            return [f.name for f in model._meta.fields]  # change through the app so the rules apply

    admin.site.register(model, DocAdmin)


_readonly_doc(Receipt, ReceiptLine, ["location", "supplier", "supplied_on"])
_readonly_doc(Transfer, TransferLine, ["source", "destination"])
_readonly_doc(StockRequest, StockRequestLine, ["kind", "location", "source"])
_readonly_doc(Sale, SaleLine, ["location", "payment_method"])
admin.site.register(StockCount)
