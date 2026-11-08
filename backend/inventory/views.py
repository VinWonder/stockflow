from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Count, DecimalField, ExpressionWrapper, F, Q, Sum
from django.db.models.functions import TruncDate
from django.utils import timezone
from rest_framework import mixins, permissions, status, viewsets
from rest_framework.decorators import action, api_view
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from . import services
from .models import (Category, Location, Product, Receipt, Sale, StockCount, StockCountLine, StockLevel,
                     StockMovement, StockRequest, Supplier, Transfer, Variant)
from .serializers import (CategorySerializer, LocationSerializer, MovementSerializer, ProductSerializer,
                          QuantityMapSerializer, ReceiptSerializer, SaleSerializer, StockCountSerializer,
                          StockLevelSerializer, StockRequestSerializer, SupplierSerializer, TransferSerializer,
                          VariantSerializer)


class AdminWriteOrReadOnly(permissions.BasePermission):
    """Everyone signed in can read; only admins change master data (products, prices, stores)."""

    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False
        if request.method in permissions.SAFE_METHODS:
            return True
        return request.user.is_admin


class ManagerWrite(permissions.BasePermission):
    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False
        return request.method in permissions.SAFE_METHODS or request.user.is_admin or request.user.role == "manager"


class ScopedMixin:
    """Limit documents to the user's locations. `location_fields` lists FK names to check."""

    location_fields = ("location",)

    def scope(self, qs):
        user = self.request.user
        if user.is_admin:
            return qs
        ids = user.accessible_location_ids()
        q = Q()
        for f in self.location_fields:
            q |= Q(**{f"{f}_id__in": ids})
        return qs.filter(q)

    def check_location(self, location):
        if not self.request.user.can_access(location):
            raise PermissionDenied(f"You don't work at {location.name}.")


class IdempotentCreateMixin:
    """If the phone retries a POST with the same client_uuid, return the first result instead of a duplicate."""

    def create(self, request, *args, **kwargs):
        cuid = request.data.get("client_uuid")
        if cuid:
            existing = self.get_queryset().model.objects.filter(client_uuid=cuid).first()
            if existing:
                return Response(self.get_serializer(existing).data, status=status.HTTP_200_OK)
        return super().create(request, *args, **kwargs)


# ----------------------------------------------------------------------------- master data
class LocationViewSet(viewsets.ModelViewSet):
    serializer_class = LocationSerializer
    permission_classes = [AdminWriteOrReadOnly]
    search_fields = ["name", "code"]
    filterset_fields = ["kind", "is_active", "can_sell"]

    def get_queryset(self):
        return Location.objects.filter(id__in=self.request.user.accessible_location_ids())

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        ctx["summaries"] = services.location_summary(self.request.user.accessible_location_ids())
        return ctx

    @action(detail=False)
    def directory(self, request):
        """Every active store, without stock figures, so staff can choose a transfer destination."""
        rows = Location.objects.filter(is_active=True)
        return Response([{"id": l.id, "code": l.code, "name": l.name, "kind": l.kind, "is_main": l.is_main,
                          "color": l.color, "can_sell": l.can_sell, "address": l.address} for l in rows])

    def perform_destroy(self, loc):
        if loc.movements.exists():
            loc.is_active = False  # keep history: archive instead of deleting
            loc.save()
        else:
            loc.delete()


class CategoryViewSet(viewsets.ModelViewSet):
    queryset = Category.objects.annotate(product_count=Count("products"))
    serializer_class = CategorySerializer
    permission_classes = [AdminWriteOrReadOnly]
    search_fields = ["name"]
    pagination_class = None


class ProductViewSet(viewsets.ModelViewSet):
    serializer_class = ProductSerializer
    permission_classes = [AdminWriteOrReadOnly]
    search_fields = ["name", "code", "brand", "variants__sku", "variants__barcode"]
    filterset_fields = ["category", "is_active", "unit"]
    ordering_fields = ["name", "created_at", "total_stock"]

    def get_queryset(self):
        ids = self.request.user.accessible_location_ids()
        return (Product.objects.select_related("category").prefetch_related("variants__product")
                .annotate(total_stock=Sum("variants__levels__quantity", filter=Q(variants__levels__location_id__in=ids)))
                .distinct())


class VariantViewSet(viewsets.ModelViewSet):
    serializer_class = VariantSerializer
    permission_classes = [AdminWriteOrReadOnly]
    search_fields = ["sku", "barcode", "product__name", "product__code", "size", "colour", "product__brand"]
    filterset_fields = ["product", "is_active", "product__category"]

    def get_queryset(self):
        return Variant.objects.select_related("product")

    @action(detail=False, url_path="barcode/(?P<code>[^/.]+)")
    def by_barcode(self, request, code=None):
        v = Variant.objects.filter(Q(barcode=code) | Q(sku__iexact=code)).select_related("product").first()
        if not v:
            return Response({"detail": "No product with this barcode."}, status=404)
        return Response(self.get_serializer(v).data)


class SupplierViewSet(viewsets.ModelViewSet):
    serializer_class = SupplierSerializer
    permission_classes = [ManagerWrite]
    search_fields = ["name", "phone", "contact_person"]
    filterset_fields = ["is_active"]

    def get_queryset(self):
        posted = Q(receipts__status="posted")
        line_total = ExpressionWrapper(F("receipts__lines__quantity") * F("receipts__lines__unit_cost"),
                                       output_field=DecimalField(max_digits=16, decimal_places=2))
        return Supplier.objects.annotate(total_supplied=Sum(line_total, filter=posted),
                                         deliveries=Count("receipts", filter=posted, distinct=True))


# ----------------------------------------------------------------------------- stock
class StockLevelViewSet(ScopedMixin, mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.UpdateModelMixin,
                        viewsets.GenericViewSet):
    """Read balances. PATCH only edits reorder level / shelf, never quantity."""

    serializer_class = StockLevelSerializer
    permission_classes = [ManagerWrite]
    search_fields = ["variant__sku", "variant__product__name", "variant__product__code", "variant__barcode",
                     "variant__size", "variant__colour"]
    filterset_fields = {"location": ["exact"], "variant": ["exact"], "variant__product__category": ["exact"]}
    ordering_fields = ["quantity", "variant__product__name", "updated_at"]
    ordering = ["variant__product__name"]

    def get_queryset(self):
        qs = self.scope(StockLevel.objects.select_related("variant__product", "location"))
        p = self.request.query_params
        if p.get("in_stock") == "1":
            qs = qs.filter(quantity__gt=0)
        if p.get("low") == "1":
            qs = [lv for lv in qs if lv.is_low]  # small lists; uses product defaults + overrides
        return qs

    def list(self, request, *args, **kwargs):
        if request.query_params.get("low") == "1":
            data = self.get_serializer(self.get_queryset(), many=True).data
            return Response({"count": len(data), "results": data, "next": None, "previous": None})
        return super().list(request, *args, **kwargs)


class MovementViewSet(ScopedMixin, viewsets.ReadOnlyModelViewSet):
    """The ledger. Filter by location + variant for an item's full history (stock card)."""

    serializer_class = MovementSerializer
    filterset_fields = {"location": ["exact"], "variant": ["exact"], "kind": ["exact", "in"],
                        "created_at": ["gte", "lte"], "reference": ["exact"]}
    search_fields = ["reference", "variant__sku", "variant__product__name", "note"]

    def get_queryset(self):
        return self.scope(StockMovement.objects.select_related("variant__product", "location", "user"))


# ----------------------------------------------------------------------------- documents
class DocumentViewSet(ScopedMixin, IdempotentCreateMixin, mixins.CreateModelMixin, viewsets.ReadOnlyModelViewSet):
    search_fields = ["code", "notes"]

    def perform_create(self, serializer):
        for f in self.location_fields:
            loc = serializer.validated_data.get(f)
            if loc is not None and f == self.location_fields[0]:
                self.check_location(loc)
        return serializer.save(created_by=self.request.user)

    def _reply(self, obj):
        return Response(self.get_serializer(type(obj).objects.get(pk=obj.pk)).data)

    def _payload(self, request):
        s = QuantityMapSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        return s.validated_data.get("quantities") or {}, s.validated_data.get("reason", "")


class ReceiptViewSet(DocumentViewSet):
    serializer_class = ReceiptSerializer
    permission_classes = [ManagerWrite]
    filterset_fields = ["location", "supplier", "status"]
    search_fields = ["code", "invoice_number", "supplier__name"]

    def get_queryset(self):
        return self.scope(Receipt.objects.select_related("location", "supplier", "created_by").prefetch_related("lines__variant__product"))

    def create(self, request, *args, **kwargs):
        cuid = request.data.get("client_uuid")
        if cuid and Receipt.objects.filter(client_uuid=cuid).exists():
            return Response(self.get_serializer(Receipt.objects.get(client_uuid=cuid)).data)
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        post_now = serializer.validated_data.get("post_now", True)
        with transaction.atomic():
            receipt = self.perform_create(serializer)
            if post_now:
                services.post_receipt(receipt, request.user)
        return Response(self.get_serializer(Receipt.objects.get(pk=receipt.pk)).data, status=201)

    @action(detail=True, methods=["post"], url_path="post")
    def post_receipt(self, request, pk=None):
        return self._reply(services.post_receipt(self.get_object(), request.user))

    @action(detail=True, methods=["post"])
    def void(self, request, pk=None):
        _, reason = self._payload(request)
        return self._reply(services.void_receipt(self.get_object(), request.user, reason))

    @action(detail=True, methods=["post"])
    def payment(self, request, pk=None):
        receipt = self.get_object()
        if not request.user.is_admin:
            raise PermissionDenied("Only an admin can record supplier payments.")
        amount = Decimal(str(request.data.get("amount", "0")))
        receipt.amount_paid = max(Decimal("0"), receipt.amount_paid + amount)
        receipt.save(update_fields=["amount_paid", "updated_at"])
        return self._reply(receipt)


class TransferViewSet(DocumentViewSet):
    serializer_class = TransferSerializer
    location_fields = ("source", "destination")
    filterset_fields = ["source", "destination", "status"]

    def get_queryset(self):
        return self.scope(Transfer.objects.select_related(
            "source", "destination", "created_by", "approved_by", "dispatched_by", "received_by"
        ).prefetch_related("lines__variant__product"))

    def perform_create(self, serializer):
        user = self.request.user
        src, dst = serializer.validated_data["source"], serializer.validated_data["destination"]
        if not (user.can_access(src) or user.can_access(dst)):
            raise PermissionDenied("You can only request transfers for your own stores.")
        t = serializer.save(created_by=user)
        from messaging import notify

        event = "approved" if t.status == Transfer.Status.APPROVED else "requested"
        transaction.on_commit(lambda: notify.transfer_changed(t.pk, event))
        return t

    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        return self._reply(services.approve_transfer(self.get_object(), request.user))

    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        _, reason = self._payload(request)
        return self._reply(services.reject_transfer(self.get_object(), request.user, reason))

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        return self._reply(services.cancel_transfer(self.get_object(), request.user))

    @action(detail=True, methods=["post"], url_path="dispatch")
    def send_out(self, request, pk=None):
        return self._reply(services.dispatch_transfer(self.get_object(), request.user))

    @action(detail=True, methods=["post"])
    def receive(self, request, pk=None):
        quantities, _ = self._payload(request)
        return self._reply(services.receive_transfer(self.get_object(), request.user, quantities))


class StockRequestViewSet(DocumentViewSet):
    serializer_class = StockRequestSerializer
    filterset_fields = ["location", "status", "kind", "source"]

    def get_queryset(self):
        return self.scope(StockRequest.objects.select_related(
            "location", "created_by", "confirmed_by", "approved_by").prefetch_related("lines__variant__product"))

    def perform_create(self, serializer):
        self.check_location(serializer.validated_data["location"])
        req = serializer.save(created_by=self.request.user, source="app")
        transaction.on_commit(lambda: services.after_request_created(req))
        return req

    @action(detail=True, methods=["post"])
    def confirm(self, request, pk=None):
        quantities, _ = self._payload(request)
        return self._reply(services.confirm_request(self.get_object(), request.user, quantities))

    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        return self._reply(services.approve_request(self.get_object(), request.user))

    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        _, reason = self._payload(request)
        return self._reply(services.reject_request(self.get_object(), request.user, reason))

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        return self._reply(services.cancel_request(self.get_object(), request.user))


class SaleViewSet(DocumentViewSet):
    serializer_class = SaleSerializer
    filterset_fields = ["location", "status", "payment_method"]
    search_fields = ["code", "customer_name", "customer_phone", "payment_reference"]

    def get_queryset(self):
        return self.scope(Sale.objects.select_related("location", "created_by").prefetch_related("lines__variant__product"))

    def create(self, request, *args, **kwargs):
        cuid = request.data.get("client_uuid")
        if cuid and Sale.objects.filter(client_uuid=cuid).exists():
            return Response(self.get_serializer(Sale.objects.get(client_uuid=cuid)).data)
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            sale = self.perform_create(serializer)
            services.post_sale(sale, request.user)
        return Response(self.get_serializer(Sale.objects.get(pk=sale.pk)).data, status=201)

    @action(detail=True, methods=["post"])
    def void(self, request, pk=None):
        _, reason = self._payload(request)
        return self._reply(services.void_sale(self.get_object(), request.user, reason))


class StockCountViewSet(ScopedMixin, viewsets.ReadOnlyModelViewSet):
    serializer_class = StockCountSerializer
    filterset_fields = ["location", "status"]

    def get_queryset(self):
        return self.scope(StockCount.objects.select_related("location").prefetch_related("lines__variant__product"))

    def create(self, request):
        location = Location.objects.get(pk=request.data.get("location"))
        self.check_location(location)
        count = services.start_count(location, request.user, request.data.get("variants"), request.data.get("notes", ""))
        return Response(self.get_serializer(count).data, status=201)

    @action(detail=True, methods=["post"])
    def record(self, request, pk=None):
        """Save counted quantities as you go: {"quantities": {"<line id>": "12"}}"""
        count = self.get_object()
        if count.status != StockCount.Status.OPEN or not request.user.can_manage(count.location):
            raise PermissionDenied("This count is closed or you can't edit it.")
        quantities, _ = self._payload(request)
        for line_id, qty in quantities.items():
            StockCountLine.objects.filter(count=count, pk=int(line_id)).update(counted=qty)
        return Response(self.get_serializer(StockCount.objects.get(pk=count.pk)).data)

    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        return Response(self.get_serializer(services.submit_count(self.get_object(), request.user)).data)

    @action(detail=True, methods=["post"], url_path="post")
    def post_count(self, request, pk=None):
        return Response(self.get_serializer(services.post_count(self.get_object(), request.user)).data)

    _payload = DocumentViewSet._payload


# ----------------------------------------------------------------------------- dashboard
@api_view(["GET"])
def dashboard(request):
    user = request.user
    ids = user.accessible_location_ids()
    loc_param = request.query_params.get("location")
    if loc_param:
        if not loc_param.isdigit() or int(loc_param) not in ids:
            raise PermissionDenied("Not your location.")
        ids = [int(loc_param)]
    now = timezone.now()
    today = timezone.localdate()
    since = now - timedelta(days=30)
    summaries = services.location_summary(ids)
    sales = Sale.objects.filter(location_id__in=ids, status="completed")
    sale_total = ExpressionWrapper(F("lines__quantity") * F("lines__unit_price"), output_field=DecimalField(max_digits=16, decimal_places=2))
    sale_cost = ExpressionWrapper(F("lines__quantity") * F("lines__unit_cost"), output_field=DecimalField(max_digits=16, decimal_places=2))
    today_sales = sales.filter(created_at__date=today).aggregate(t=Sum(sale_total), c=Sum(sale_cost), n=Count("id", distinct=True))
    month_sales = sales.filter(created_at__gte=since).aggregate(t=Sum(sale_total), c=Sum(sale_cost))
    daily = (StockMovement.objects.filter(location_id__in=ids, created_at__gte=now - timedelta(days=14))
             .annotate(day=TruncDate("created_at")).values("day")
             .annotate(stock_in=Sum("quantity", filter=Q(quantity__gt=0)), stock_out=Sum("quantity", filter=Q(quantity__lt=0)))
             .order_by("day"))
    top = (StockMovement.objects.filter(location_id__in=ids, kind__in=["sale", "transfer_out", "removal"], created_at__gte=since)
           .values("variant_id", "variant__sku", "variant__product__name", "variant__size", "variant__colour")
           .annotate(moved=Sum("quantity")).order_by("moved")[:8])
    low = [lv for lv in StockLevel.objects.filter(location_id__in=ids).select_related("variant__product", "location") if lv.is_low]
    pending_requests = StockRequest.objects.filter(location_id__in=ids, status__in=["pending", "confirmed"])
    transfers_open = Transfer.objects.filter(Q(source_id__in=ids) | Q(destination_id__in=ids),
                                             status__in=["requested", "approved", "in_transit"])
    return Response({
        "totals": {
            "stock_value": str(round(sum((s["value"] for s in summaries.values()), Decimal(0)), 2)),
            "items_in_stock": sum(s["items"] for s in summaries.values()),
            "low_stock": sum(s["low"] for s in summaries.values()),
            "out_of_stock": sum(s["out"] for s in summaries.values()),
            "sales_today": str(today_sales["t"] or 0),
            "profit_today": str((today_sales["t"] or 0) - (today_sales["c"] or 0)),
            "sales_count_today": today_sales["n"] or 0,
            "sales_30d": str(month_sales["t"] or 0),
            "profit_30d": str((month_sales["t"] or 0) - (month_sales["c"] or 0)),
        },
        "action_needed": {
            "requests_waiting_manager": pending_requests.filter(status="pending").count(),
            "requests_waiting_approval": pending_requests.filter(status="confirmed").count(),
            "transfers_to_approve": transfers_open.filter(status="requested").count(),
            "transfers_to_dispatch": transfers_open.filter(status="approved").count(),
            "transfers_in_transit": transfers_open.filter(status="in_transit").count(),
            "counts_to_post": StockCount.objects.filter(location_id__in=ids, status="submitted").count(),
        },
        "locations": [{"id": k, **{kk: str(vv) if isinstance(vv, Decimal) else vv for kk, vv in v.items()}} for k, v in summaries.items()],
        "movement_14d": [{"day": d["day"], "in": str(d["stock_in"] or 0), "out": str(abs(d["stock_out"] or 0))} for d in daily],
        "top_moving_30d": [{"variant": t["variant_id"], "sku": t["variant__sku"],
                            "name": " ".join(x for x in [t["variant__product__name"], t["variant__size"], t["variant__colour"]] if x),
                            "quantity": str(abs(t["moved"]))} for t in top],
        "low_stock_items": StockLevelSerializer(sorted(low, key=lambda lv: lv.quantity)[:10], many=True).data,
        "recent_movements": MovementSerializer(
            StockMovement.objects.filter(location_id__in=ids).select_related("variant__product", "location", "user")[:10], many=True).data,
    })
