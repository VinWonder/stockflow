from collections import defaultdict
from datetime import datetime, time, timedelta
from decimal import Decimal

from django.conf import settings
from django.db import transaction
from django.db.models import Count, DecimalField, ExpressionWrapper, F, OuterRef, Q, Subquery, Sum
from django.db.models.functions import Coalesce, TruncDate
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import mixins, permissions, status, viewsets
from rest_framework.decorators import action, api_view, permission_classes, throttle_classes
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle

from . import mpesa, services
from .exceptions import StockError
from .models import (Category, Customer, Location, MpesaPayment, Product, Receipt, ReceiptLine, Sale, SalePayment,
                     StockCount, StockCountLine, StockLevel, StockMovement, StockRequest, Supplier, Transfer, Variant,
                     Vehicle)
from .serializers import (CategorySerializer, CustomerSerializer, LocationSerializer, MovementSerializer,
                          MpesaPaymentSerializer, ProductSerializer, QuantityMapSerializer, ReceiptSerializer,
                          SaleSerializer, StockCountSerializer, StockLevelSerializer, StockRequestSerializer,
                          SupplierSerializer, TransferSerializer, VariantSerializer)

MONEY_FIELD = DecimalField(max_digits=16, decimal_places=2)


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


class BusinessMixin:
    """Master data (products, suppliers, customers…) belongs to the signed-in user's business."""

    def business_id(self):
        return self.request.user.business_id

    def perform_create(self, serializer):
        serializer.save(business_id=self.business_id())


class ScopedMixin:
    """Limit documents to the user's stores (admins: every store in their business)."""

    location_fields = ("location",)

    def scope(self, qs):
        ids = self.request.user.accessible_location_ids()
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
            existing = self.get_queryset().filter(client_uuid=cuid).first()
            if existing:
                return Response(self.get_serializer(existing).data, status=status.HTTP_200_OK)
        return super().create(request, *args, **kwargs)


def _int(value):
    return int(value) if value not in (None, "") and str(value).isdigit() else None


# ----------------------------------------------------------------------------- master data
class LocationViewSet(viewsets.ModelViewSet):
    """Shops and godowns. Admins see and manage every store in the business; staff see the stores they work in."""

    serializer_class = LocationSerializer
    permission_classes = [AdminWriteOrReadOnly]
    search_fields = ["name", "code", "address"]
    filterset_fields = ["kind", "is_active", "can_sell"]
    pagination_class = None

    def get_queryset(self):
        return Location.objects.filter(id__in=self.request.user.accessible_location_ids())

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        if self.request.user.is_authenticated:
            ctx["summaries"] = services.location_summary(self.request.user.accessible_location_ids())
        return ctx

    def perform_create(self, serializer):
        serializer.save(business_id=self.request.user.business_id)

    @action(detail=False)
    def directory(self, request):
        """Every active store in the business, without stock figures, so staff can choose a transfer destination."""
        rows = Location.objects.filter(business_id=request.user.business_id, is_active=True)
        mine = set(request.user.accessible_location_ids())
        return Response([{"id": l.id, "code": l.code, "name": l.name, "kind": l.kind, "is_main": l.is_main,
                          "color": l.color, "can_sell": l.can_sell, "address": l.address, "latitude": l.latitude,
                          "longitude": l.longitude, "mine": l.id in mine} for l in rows])

    def perform_destroy(self, loc):
        if loc.movements.exists() or loc.levels.filter(quantity__gt=0).exists():
            loc.is_active = False  # keep history: archive instead of deleting
            loc.save()
        else:
            loc.delete()


class CategoryViewSet(BusinessMixin, viewsets.ModelViewSet):
    serializer_class = CategorySerializer
    permission_classes = [AdminWriteOrReadOnly]
    search_fields = ["name"]
    pagination_class = None

    def get_queryset(self):
        return Category.objects.filter(business_id=self.business_id()).annotate(product_count=Count("products"))


class ProductViewSet(BusinessMixin, viewsets.ModelViewSet):
    serializer_class = ProductSerializer
    permission_classes = [AdminWriteOrReadOnly]
    search_fields = ["name", "code", "brand", "variants__sku", "variants__size", "variants__colour"]
    filterset_fields = ["category", "is_active", "unit", "suppliers"]
    ordering_fields = ["name", "created_at", "total_stock"]

    def get_queryset(self):
        ids = self.request.user.accessible_location_ids()
        return (Product.objects.filter(business_id=self.business_id()).select_related("category")
                .prefetch_related("variants__product", "suppliers")
                .annotate(total_stock=Sum("variants__levels__quantity", filter=Q(variants__levels__location_id__in=ids)))
                .order_by("name"))

    def perform_destroy(self, product):
        used = StockMovement.objects.filter(variant__product=product).exists()
        if used:
            product.is_active = False  # keep history
            product.save(update_fields=["is_active", "updated_at"])
            product.variants.update(is_active=False)
        else:
            product.delete()


class VariantViewSet(viewsets.ModelViewSet):
    """Sizes / colours. Search by name, size, colour or code: hardware items have no barcodes."""

    serializer_class = VariantSerializer
    permission_classes = [AdminWriteOrReadOnly]
    search_fields = ["sku", "product__name", "product__code", "size", "colour", "product__brand"]
    filterset_fields = ["product", "is_active", "product__category"]

    def get_queryset(self):
        qs = Variant.objects.filter(product__business_id=self.request.user.business_id).select_related("product")
        supplier = _int(self.request.query_params.get("supplier"))
        if supplier:
            qs = qs.filter(product__suppliers=supplier)
        if self.request.query_params.get("is_active") in ("true", "1"):
            qs = qs.filter(product__is_active=True)
        return qs.distinct()

    def perform_destroy(self, variant):
        if variant.movements.exists():
            variant.is_active = False
            variant.save(update_fields=["is_active", "updated_at"])
        else:
            variant.delete()


class SupplierViewSet(BusinessMixin, viewsets.ModelViewSet):
    serializer_class = SupplierSerializer
    permission_classes = [ManagerWrite]
    search_fields = ["name", "phone", "contact_person"]
    filterset_fields = ["is_active"]

    def get_queryset(self):
        line_total = ExpressionWrapper(F("quantity") * F("unit_cost"), output_field=MONEY_FIELD)
        supplied = (ReceiptLine.objects.filter(receipt__supplier=OuterRef("pk"), receipt__status="posted")
                    .values("receipt__supplier").annotate(t=Sum(line_total)).values("t"))
        deliveries = (Receipt.objects.filter(supplier=OuterRef("pk"), status="posted")
                      .values("supplier").annotate(n=Count("id")).values("n"))
        products = (Product.objects.filter(suppliers=OuterRef("pk"), is_active=True)
                    .values("suppliers").annotate(n=Count("id")).values("n"))
        return (Supplier.objects.filter(business_id=self.business_id())
                .annotate(total_supplied=Coalesce(Subquery(supplied, output_field=MONEY_FIELD), Decimal(0)),
                          deliveries=Coalesce(Subquery(deliveries), 0),
                          product_count=Coalesce(Subquery(products), 0)))

    @action(detail=True)
    def products(self, request, pk=None):
        """Products this supplier brings (linked by hand or from earlier deliveries)."""
        supplier = self.get_object()
        variants = Variant.objects.filter(product__suppliers=supplier, is_active=True, product__is_active=True)
        return Response(VariantSerializer(variants.select_related("product"), many=True, context={"request": request}).data)


class CustomerViewSet(BusinessMixin, viewsets.ModelViewSet):
    """Customers, mainly for credit: who owes what, and what is overdue."""

    serializer_class = CustomerSerializer
    search_fields = ["name", "phone"]
    filterset_fields = ["is_active"]

    def get_queryset(self):
        return (Customer.objects.filter(business_id=self.business_id())
                .annotate(credit_sales=Count("sales", filter=Q(sales__payment_method="credit", sales__status="completed"))))

    def get_permissions(self):
        if self.action in ("update", "partial_update", "destroy"):
            return [AdminWriteOrReadOnly()]
        return [permissions.IsAuthenticated()]

    def list(self, request, *args, **kwargs):
        if request.query_params.get("owing") == "1":
            qs = self.filter_queryset(self.get_queryset())
            rows = [r for r in self.get_serializer(qs, many=True).data if Decimal(r["owed"]) > 0]
            rows.sort(key=lambda r: (-Decimal(r["overdue"]), -Decimal(r["owed"])))
            return Response({"count": len(rows), "next": None, "previous": None, "results": rows})
        return super().list(request, *args, **kwargs)

    @action(detail=True)
    def statement(self, request, pk=None):
        customer = self.get_object()
        ids = request.user.accessible_location_ids()
        sales = (customer.sales.filter(location_id__in=ids).select_related("location", "created_by")
                 .prefetch_related("lines__variant__product", "payments__received_by")[:100])
        return Response({"customer": self.get_serializer(customer).data,
                         "sales": SaleSerializer(sales, many=True, context={"request": request}).data})


# ----------------------------------------------------------------------------- stock
class StockLevelViewSet(ScopedMixin, mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.UpdateModelMixin,
                        viewsets.GenericViewSet):
    """Read balances. PATCH only edits reorder level / shelf, never quantity.

    ?state=low (running low, still some left) · ?state=out (none left) · ?state=alert (both) · ?low=1 (= alert)
    """

    serializer_class = StockLevelSerializer
    permission_classes = [ManagerWrite]
    search_fields = ["variant__sku", "variant__product__name", "variant__product__code", "variant__size",
                     "variant__colour", "variant__product__brand"]
    filterset_fields = {"location": ["exact"], "variant": ["exact"], "variant__product__category": ["exact"]}
    ordering_fields = ["quantity", "variant__product__name", "updated_at"]
    ordering = ["variant__product__name"]

    def _state(self):
        p = self.request.query_params
        return "alert" if p.get("low") == "1" else p.get("state", "")

    def get_queryset(self):
        qs = self.scope(StockLevel.objects.select_related("variant__product", "location")
                        .filter(variant__is_active=True, variant__product__is_active=True, location__is_active=True))
        if self.request.query_params.get("in_stock") == "1":
            qs = qs.filter(quantity__gt=0)
        reorder = Coalesce("reorder_level", "variant__product__reorder_level")
        state = self._state()
        if state == "out":
            qs = qs.filter(quantity__lte=0)
        elif state == "low":
            qs = qs.filter(quantity__gt=0, quantity__lte=reorder)
        elif state == "alert":
            qs = qs.filter(quantity__lte=reorder)
        if state:
            qs = qs.order_by("quantity", "variant__product__name")
        return qs


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
        loc = serializer.validated_data.get(self.location_fields[0])
        if loc is not None:
            self.check_location(loc)
        return serializer.save(created_by=self.request.user)

    def _reply(self, obj):
        return Response(self.get_serializer(type(obj).objects.get(pk=obj.pk)).data)

    def _payload(self, request):
        s = QuantityMapSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        return s.validated_data.get("quantities") or {}, s.validated_data.get("reason", "")

    def filter_queryset(self, qs):
        """?status_in=requested,approved lets one list show several steps at once."""
        statuses = self.request.query_params.get("status_in", "")
        if statuses:
            qs = qs.filter(status__in=[s for s in statuses.split(",") if s])
        return super().filter_queryset(qs)


class ReceiptViewSet(DocumentViewSet):
    serializer_class = ReceiptSerializer
    permission_classes = [ManagerWrite]
    filterset_fields = ["location", "supplier", "status"]
    search_fields = ["code", "invoice_number", "supplier__name"]

    def get_queryset(self):
        return self.scope(Receipt.objects.select_related("location", "supplier", "created_by").prefetch_related("lines__variant__product"))

    def create(self, request, *args, **kwargs):
        cuid = request.data.get("client_uuid")
        if cuid and (existing := self.get_queryset().filter(client_uuid=cuid).first()):
            return Response(self.get_serializer(existing).data)
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


def _driver_data(data):
    return {k: data.get(k) for k in ("driver_name", "driver_phone", "vehicle_type", "vehicle_reg")}


def public_url(request, path=""):
    base = settings.PUBLIC_APP_URL or request.build_absolute_uri("/").rstrip("/")
    return f"{base}{path}"


def tracking_link(request, transfer):
    return public_url(request, f"/drive/{transfer.tracking_token}")


class TransferViewSet(DocumentViewSet):
    serializer_class = TransferSerializer
    location_fields = ("source", "destination")
    filterset_fields = ["source", "destination", "status", "vehicle_type"]
    search_fields = ["code", "notes", "driver_name", "driver_phone", "vehicle_reg"]

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
        """Body: {driver_name, driver_phone, vehicle_type, vehicle_reg, notify_driver}."""
        t = services.dispatch_transfer(self.get_object(), request.user, _driver_data(request.data))
        sms_live = settings.MESSAGING["SMS_BACKEND"] != "console"
        if request.data.get("notify_driver", True) and t.driver_phone and sms_live:
            link = tracking_link(request, t)
            from messaging.gateways import send

            text = (f"StockFlow {t.code}: you are taking goods from {t.source.name} to {t.destination.name}. "
                    f"Open this link and keep it open to share your location: {link}")
            transaction.on_commit(lambda: send("sms", t.driver_phone, text))
        return self._reply(t)

    @action(detail=True, methods=["post"])
    def driver(self, request, pk=None):
        """Change driver / vehicle details before or during the trip."""
        t = self.get_object()
        if not (request.user.can_manage(t.source) or request.user.is_admin):
            raise PermissionDenied("Only the sending store's manager or an admin can change the driver.")
        if t.status in (Transfer.Status.RECEIVED, Transfer.Status.CANCELLED, Transfer.Status.REJECTED):
            raise StockError("This transfer is closed.")
        services.set_driver(t, _driver_data(request.data))
        t.save()
        return self._reply(t)

    @action(detail=True, methods=["get", "post"])
    def track(self, request, pk=None):
        """GET: live position, route so far, distance left and ETA. POST {lat, lng, …}: share from the app."""
        t = self.get_object()
        if request.method == "POST":
            services.record_track_point(t, request.data.get("lat"), request.data.get("lng"), request.data.get("accuracy"),
                                        request.data.get("speed"), request.data.get("heading"))
        data = services.tracking_summary(t)
        data["driver_link"] = tracking_link(request, t) if t.tracking_token else None
        return Response(data)

    @action(detail=True, methods=["post"])
    def receive(self, request, pk=None):
        quantities, _ = self._payload(request)
        return self._reply(services.receive_transfer(self.get_object(), request.user, quantities))


class TrackThrottle(AnonRateThrottle):
    rate = "60/min"


@api_view(["GET", "POST"])
@permission_classes([permissions.AllowAny])
@throttle_classes([TrackThrottle])
def driver_tracking(request, token):
    """The driver's page (no login): see the trip and send GPS fixes. The token is the secret."""
    t = get_object_or_404(Transfer.objects.select_related("source", "destination"), tracking_token=token)
    if request.method == "POST":
        services.record_track_point(t, request.data.get("lat"), request.data.get("lng"), request.data.get("accuracy"),
                                    request.data.get("speed"), request.data.get("heading"))
    summary = services.tracking_summary(t)
    summary.pop("points", None)
    return Response({
        "code": t.code, "status": t.status, "status_label": t.get_status_display(),
        "from": t.source.name, "from_address": t.source.address, "to": t.destination.name,
        "to_address": t.destination.address, "to_phone": t.destination.phone,
        "driver_name": t.driver_name, "vehicle": t.get_vehicle_type_display(), "vehicle_reg": t.vehicle_reg,
        "items": t.lines.count(), **summary,
    })


class StockRequestViewSet(DocumentViewSet):
    serializer_class = StockRequestSerializer
    filterset_fields = ["location", "status", "kind", "source"]

    def get_queryset(self):
        return self.scope(StockRequest.objects.select_related(
            "location", "created_by", "confirmed_by", "approved_by").prefetch_related("lines__variant__product"))

    def create(self, request, *args, **kwargs):
        cuid = request.data.get("client_uuid")
        if cuid and (existing := self.get_queryset().filter(client_uuid=cuid).first()):
            return Response(self.get_serializer(existing).data)
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        apply_now = serializer.validated_data.get("apply_now") and request.user.is_admin
        with transaction.atomic():
            self.check_location(serializer.validated_data["location"])
            req = serializer.save(created_by=request.user, source="app")
            if apply_now:
                # The owner did it themselves: record and approve in one go (still a visible ledger entry).
                services.approve_request(req, request.user)
            else:
                transaction.on_commit(lambda: services.after_request_created(req))
        return Response(self.get_serializer(StockRequest.objects.get(pk=req.pk)).data, status=201)

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
    filterset_fields = ["location", "status", "payment_method", "customer"]
    search_fields = ["code", "customer_name", "customer_phone", "payment_reference"]

    def get_queryset(self):
        return self.scope(Sale.objects.select_related("location", "created_by", "customer")
                          .prefetch_related("lines__variant__product", "payments__received_by"))

    def list(self, request, *args, **kwargs):
        if request.query_params.get("owing") == "1":
            rows = [s for s in self.filter_queryset(self.get_queryset()).filter(status="completed")[:500] if s.balance > 0]
            return Response({"count": len(rows), "next": None, "previous": None,
                             "results": self.get_serializer(rows, many=True).data})
        return super().list(request, *args, **kwargs)

    def create(self, request, *args, **kwargs):
        cuid = request.data.get("client_uuid")
        if cuid and (existing := self.get_queryset().filter(client_uuid=cuid).first()):
            return Response(self.get_serializer(existing).data)
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        mpesa_id = serializer.validated_data.get("mpesa_payment")
        deposit = serializer.validated_data.get("deposit")
        with transaction.atomic():
            sale = self.perform_create(serializer)
            services.post_sale(sale, request.user, mpesa_payment_id=mpesa_id, deposit=deposit)
        return Response(self.get_serializer(Sale.objects.get(pk=sale.pk)).data, status=201)

    @action(detail=True, methods=["post"])
    def void(self, request, pk=None):
        _, reason = self._payload(request)
        return self._reply(services.void_sale(self.get_object(), request.user, reason))

    @action(detail=True, methods=["post"])
    def pay(self, request, pk=None):
        """Customer pays a credit sale: {amount, method: cash|mpesa|bank|card, reference}."""
        d = request.data
        return self._reply(services.record_sale_payment(self.get_object(), request.user, d.get("amount"),
                                                        d.get("method", "cash"), d.get("reference", "")))


class MpesaViewSet(viewsets.GenericViewSet):
    """Send an M-Pesa prompt to the customer's phone and watch for the result."""

    serializer_class = MpesaPaymentSerializer

    def get_queryset(self):
        return MpesaPayment.objects.filter(business_id=self.request.user.business_id)

    def create(self, request):
        loc = Location.objects.filter(pk=_int(request.data.get("location")), business_id=request.user.business_id).first()
        if not loc or not request.user.can_access(loc):
            raise PermissionDenied("Choose one of your stores.")
        callback = public_url(request, f"/api/payments/stk-callback/?token={settings.MPESA['CALLBACK_TOKEN']}")
        payment = mpesa.start_stk_push(business=request.user.business, location=loc, user=request.user,
                                       phone=request.data.get("phone", ""), amount=request.data.get("amount", 0),
                                       reference=request.data.get("reference") or loc.code, callback_url=callback)
        return Response(self.get_serializer(payment).data, status=201)

    def retrieve(self, request, pk=None):
        payment = mpesa.refresh_status(self.get_object())
        return Response(self.get_serializer(payment).data)


@api_view(["POST"])
@permission_classes([permissions.AllowAny])
def mpesa_callback(request):
    """Safaricom posts the STK result here. Protected by a secret token in the URL."""
    import hmac

    if not hmac.compare_digest(request.query_params.get("token", ""), settings.MPESA["CALLBACK_TOKEN"]):
        return Response({"ResultCode": 1, "ResultDesc": "Rejected"}, status=403)
    mpesa.handle_callback(request.data)
    return Response({"ResultCode": 0, "ResultDesc": "Accepted"})


class StockCountViewSet(ScopedMixin, viewsets.ReadOnlyModelViewSet):
    serializer_class = StockCountSerializer
    filterset_fields = ["location", "status"]

    def get_queryset(self):
        return self.scope(StockCount.objects.select_related("location").prefetch_related("lines__variant__product"))

    def create(self, request):
        location = get_object_or_404(Location, pk=_int(request.data.get("location")), business_id=request.user.business_id)
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


def _token_ok(request):
    import hmac

    return hmac.compare_digest(request.query_params.get("token", ""), settings.MPESA["CALLBACK_TOKEN"])


@api_view(["POST"])
@permission_classes([permissions.AllowAny])
def c2b_validate(request):
    """Safaricom asks before accepting a payment to the paybill / till: we accept everything."""
    if not _token_ok(request):
        return Response({"ResultCode": "C2B00016", "ResultDesc": "Rejected"}, status=403)
    return Response({"ResultCode": "0", "ResultDesc": "Accepted"})


@api_view(["POST"])
@permission_classes([permissions.AllowAny])
def c2b_confirm(request):
    """Safaricom reports a completed payment to the paybill / till; it can then be confirmed at the till."""
    if not _token_ok(request):
        return Response({"ResultCode": 1, "ResultDesc": "Rejected"}, status=403)
    mpesa.handle_c2b_confirmation(request.data)
    return Response({"ResultCode": 0, "ResultDesc": "Accepted"})


@api_view(["GET"])
def mpesa_code_check(request, code):
    """Look up a customer's M-Pesa code before completing a sale: amount, payer and whether it's already used."""
    from .models import MpesaTransaction

    code = "".join(code.split()).upper()
    business = request.user.business
    enabled = mpesa.code_check_enabled(business)
    used_sale = (Sale.objects.filter(location__business_id=request.user.business_id, payment_reference=code,
                                     status="completed").values_list("code", flat=True).first())
    out = {"code": code, "checked_with_safaricom": enabled, "found": False, "used_on": used_sale}
    if enabled:
        tx = MpesaTransaction.objects.filter(trans_id=code, shortcode=business.mpesa_shortcode).first()
        if tx:
            out.update(found=True, amount=str(tx.amount), payer=tx.payer_name, paid_at=tx.trans_time,
                       used_on=tx.used_for or used_sale)
    return Response(out)


@api_view(["GET", "POST"])
def mpesa_connect(request):
    """Owner: save the paybill / till number and ask Safaricom to report its payments to StockFlow."""
    business = request.user.business
    if request.method == "POST":
        if not request.user.is_admin:
            raise PermissionDenied("Only the owner can connect M-Pesa.")
        number = "".join(ch for ch in str(request.data.get("shortcode", "")) if ch.isdigit())
        if not 5 <= len(number) <= 7:
            raise ValidationError({"shortcode": "Enter your paybill or till store number (5 to 7 digits)."})
        business.mpesa_shortcode = number
        business.mpesa_connected_at = None
        business.save(update_fields=["mpesa_shortcode", "mpesa_connected_at"])
        mpesa.register_c2b_urls(business, public_url(request))
    return Response({"shortcode": business.mpesa_shortcode, "connected_at": business.mpesa_connected_at,
                     "server_ready": mpesa.is_live(), "codes_checked": mpesa.code_check_enabled(business)})


# ----------------------------------------------------------------------------- app config
@api_view(["GET"])
@permission_classes([permissions.AllowAny])
def app_config(request):
    """Public settings the app needs before/after sign-in (no secrets)."""
    return Response({
        "currency": settings.CURRENCY,
        "google_maps_key": settings.GOOGLE_MAPS_API_KEY,
        "mpesa_prompt": mpesa.is_live() or settings.MPESA["BACKEND"] == "console",
        "mpesa_simulated": not mpesa.is_live(),
        # False while no SMS provider is set up: the app then opens the phone's own SMS app instead.
        "sms_live": settings.MESSAGING["SMS_BACKEND"] != "console",
        "vehicles": [{"value": v, "label": l} for v, l in Vehicle.choices],
        "email_reset": True,
        "signup_email_code": settings.SIGNUP_EMAIL_CODE,
    })


# ----------------------------------------------------------------------------- dashboard
def _sales_figures(sales):
    revenue = cost = Decimal(0)
    count = items = 0
    for s in sales:
        revenue += s.total
        cost += s.cost
        count += 1
        items += sum((l.quantity for l in s.lines.all()), Decimal(0))
    profit = revenue - cost
    return {"revenue": revenue, "cost": cost, "profit": profit, "count": count, "items": items,
            "margin": round(profit / revenue * 100, 1) if revenue else None,
            "average": round(revenue / count, 2) if count else Decimal(0)}


def _s(v):
    return str(round(v, 2)) if isinstance(v, Decimal) else v


@api_view(["GET"])
def dashboard(request):
    """Owner's overview. ?location=<id> narrows everything (stock value, sales, alerts) to one shop or godown."""
    user = request.user
    ids = user.accessible_location_ids()
    loc_param = request.query_params.get("location")
    if loc_param:
        if not loc_param.isdigit() or int(loc_param) not in ids:
            raise PermissionDenied("Not your store.")
        ids = [int(loc_param)]
    now = timezone.now()
    today = timezone.localdate()
    tz = timezone.get_current_timezone()
    start_today = timezone.make_aware(datetime.combine(today, time.min), tz)
    start_yesterday = start_today - timedelta(days=1)
    since = now - timedelta(days=30)

    summaries = services.location_summary(ids)
    sales = Sale.objects.filter(location_id__in=ids, status="completed").prefetch_related("lines")
    today_sales = list(sales.filter(created_at__gte=start_today).select_related("location"))
    t = _sales_figures(today_sales)
    y = _sales_figures(sales.filter(created_at__gte=start_yesterday, created_at__lt=now - timedelta(days=1)))
    month = _sales_figures(sales.filter(created_at__gte=since))

    # Money actually collected today (includes customers paying old credit), by method.
    collected = defaultdict(Decimal)
    for p in SalePayment.objects.filter(sale__location_id__in=ids, sale__status="completed", created_at__gte=start_today):
        collected[p.method] += p.amount
    credit_today = sum((s.balance for s in today_sales if s.payment_method == "credit"), Decimal(0))

    # Best sellers today by money.
    best = defaultdict(lambda: {"quantity": Decimal(0), "revenue": Decimal(0), "name": "", "unit": ""})
    for s in today_sales:
        for l in s.lines.all():
            b = best[l.variant_id]
            b["quantity"] += l.quantity
            b["revenue"] += l.quantity * l.unit_price
    if best:
        for v in Variant.objects.filter(id__in=best).select_related("product"):
            best[v.id]["name"], best[v.id]["unit"] = v.label, v.product.unit
    best_today = sorted(best.items(), key=lambda kv: -kv[1]["revenue"])[:5]

    by_store = defaultdict(lambda: {"revenue": Decimal(0), "profit": Decimal(0), "count": 0})
    for s in today_sales:
        r = by_store[s.location_id]
        r["revenue"] += s.total
        r["profit"] += s.total - s.cost
        r["count"] += 1

    open_credit = [s for s in sales.filter(payment_method="credit") if s.balance > 0]
    owed = sum((s.balance for s in open_credit), Decimal(0))
    overdue = sum((s.balance for s in open_credit if s.due_date and s.due_date < today), Decimal(0))

    daily = (StockMovement.objects.filter(location_id__in=ids, created_at__gte=now - timedelta(days=14))
             .annotate(day=TruncDate("created_at")).values("day")
             .annotate(stock_in=Sum("quantity", filter=Q(quantity__gt=0)), stock_out=Sum("quantity", filter=Q(quantity__lt=0)))
             .order_by("day"))
    top = (StockMovement.objects.filter(location_id__in=ids, kind__in=["sale", "transfer_out", "removal"], created_at__gte=since)
           .values("variant_id", "variant__sku", "variant__product__name", "variant__size", "variant__colour")
           .annotate(moved=Sum("quantity")).order_by("moved")[:8])
    reorder = Coalesce("reorder_level", "variant__product__reorder_level")
    levels = (StockLevel.objects.filter(location_id__in=ids, variant__is_active=True, variant__product__is_active=True,
                                        location__is_active=True)
              .select_related("variant__product", "location"))
    low = levels.filter(quantity__gt=0, quantity__lte=reorder).order_by("quantity")[:12]
    out = levels.filter(quantity__lte=0).order_by("-updated_at")[:12]
    pending_requests = StockRequest.objects.filter(location_id__in=ids, status__in=["pending", "confirmed"])
    transfers_open = Transfer.objects.filter(Q(source_id__in=ids) | Q(destination_id__in=ids),
                                             status__in=["requested", "approved", "in_transit"])
    loc_names = dict(Location.objects.filter(id__in=ids).values_list("id", "name"))
    return Response({
        "generated_at": now,
        "totals": {
            "stock_value": _s(sum((s["value"] for s in summaries.values()), Decimal(0))),
            "retail_value": _s(sum((s["retail"] for s in summaries.values()), Decimal(0))),
            "items_in_stock": sum(s["items"] for s in summaries.values()),
            "units_in_stock": _s(sum((s["units"] for s in summaries.values()), Decimal(0))),
            "low_stock": sum(s["low"] for s in summaries.values()),
            "out_of_stock": sum(s["out"] for s in summaries.values()),
            "sales_today": _s(t["revenue"]),
            "profit_today": _s(t["profit"]),
            "cost_today": _s(t["cost"]),
            "margin_today": t["margin"],
            "sales_count_today": t["count"],
            "items_sold_today": _s(t["items"]),
            "average_sale_today": _s(t["average"]),
            "sales_yesterday_same_time": _s(y["revenue"]),
            "profit_yesterday_same_time": _s(y["profit"]),
            "collected_today": {k: _s(v) for k, v in collected.items()},
            "collected_today_total": _s(sum(collected.values(), Decimal(0))),
            "credit_given_today": _s(credit_today),
            "credit_owed": _s(owed),
            "credit_overdue": _s(overdue),
            "sales_30d": _s(month["revenue"]),
            "profit_30d": _s(month["profit"]),
        },
        "today_by_store": [{"location": k, "name": loc_names.get(k, ""), **{kk: _s(vv) for kk, vv in v.items()}}
                           for k, v in sorted(by_store.items(), key=lambda kv: -kv[1]["revenue"])],
        "best_sellers_today": [{"variant": k, "name": v["name"], "unit": v["unit"], "quantity": _s(v["quantity"]),
                                "revenue": _s(v["revenue"])} for k, v in best_today],
        "action_needed": {
            "requests_waiting_manager": pending_requests.filter(status="pending").count(),
            "requests_waiting_approval": pending_requests.filter(status="confirmed").count(),
            "transfers_to_approve": transfers_open.filter(status="requested").count(),
            "transfers_to_dispatch": transfers_open.filter(status="approved").count(),
            "transfers_in_transit": transfers_open.filter(status="in_transit").count(),
            "counts_to_post": StockCount.objects.filter(location_id__in=ids, status="submitted").count(),
        },
        "locations": [{"id": k, "name": loc_names.get(k, ""), **{kk: _s(vv) for kk, vv in v.items()}}
                      for k, v in summaries.items()],
        "movement_14d": [{"day": d["day"], "in": str(d["stock_in"] or 0), "out": str(abs(d["stock_out"] or 0))} for d in daily],
        "top_moving_30d": [{"variant": t["variant_id"], "sku": t["variant__sku"],
                            "name": " ".join(x for x in [t["variant__product__name"], t["variant__size"], t["variant__colour"]] if x),
                            "quantity": str(abs(t["moved"]))} for t in top],
        "low_stock_items": StockLevelSerializer(low, many=True, context={"request": request}).data,
        "out_of_stock_items": StockLevelSerializer(out, many=True, context={"request": request}).data,
        "recent_movements": MovementSerializer(
            StockMovement.objects.filter(location_id__in=ids).select_related("variant__product", "location", "user")[:10], many=True).data,
    })


@api_view(["GET"])
def stock_alerts(request):
    """Small, fast payload for the live low/out-of-stock counters (polled every few seconds)."""
    ids = request.user.accessible_location_ids()
    loc = _int(request.query_params.get("location"))
    if loc:
        if loc not in ids:
            raise PermissionDenied("Not your store.")
        ids = [loc]
    reorder = Coalesce("reorder_level", "variant__product__reorder_level")
    levels = StockLevel.objects.filter(location_id__in=ids, variant__is_active=True, variant__product__is_active=True,
                                       location__is_active=True)
    last = levels.order_by("-updated_at").values_list("updated_at", flat=True).first()
    return Response({"low": levels.filter(quantity__gt=0, quantity__lte=reorder).count(),
                     "out": levels.filter(quantity__lte=0).count(), "changed_at": last})
