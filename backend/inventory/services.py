"""
All stock-changing logic lives here. Views and the SMS/WhatsApp handler call these functions;
nothing else touches StockLevel.quantity.

Every public function runs in ONE database transaction and locks the affected StockLevel rows
(SELECT … FOR UPDATE) in a fixed order, so two phones selling the last bag of cement at the
same moment can never drive stock negative or deadlock each other.
"""
import math
import re
import secrets
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from .exceptions import InsufficientStock, StockError
from .models import (MOTOR_VEHICLES, ZERO, Location, MpesaPayment, Receipt, Sale, SalePayment, StockCount,
                     StockCountLine, StockLevel, StockMovement, StockRequest, TrackPoint, Transfer, Variant, Vehicle)

K = StockMovement.Kind


# ----------------------------------------------------------------------------- primitives
def _lock_levels(pairs):
    """Lock (location_id, variant_id) rows in a consistent order, creating missing ones."""
    levels = {}
    for loc_id, var_id in sorted(set(pairs)):
        StockLevel.objects.get_or_create(location_id=loc_id, variant_id=var_id)
    qs = StockLevel.objects.select_for_update().select_related("variant__product", "location")
    for level in qs.filter(location_id__in={p[0] for p in pairs}, variant_id__in={p[1] for p in pairs}).order_by("location_id", "variant_id"):
        levels[(level.location_id, level.variant_id)] = level
    return levels


def _apply(level, qty, kind, reference, user, unit_cost=ZERO, note=""):
    qty = Decimal(qty)
    new_balance = level.quantity + qty
    if new_balance < 0:
        raise InsufficientStock(level.variant, level.location, level.quantity, -qty)
    level.quantity = new_balance
    level.save(update_fields=["quantity", "updated_at"])
    return StockMovement.objects.create(
        location=level.location, variant=level.variant, kind=kind, quantity=qty, balance_after=new_balance,
        unit_cost=unit_cost, reference=reference, note=note[:255], user=user)


def _check_qty(lines):
    for line in lines:
        if line.quantity is None or line.quantity <= 0:
            raise StockError(f"Quantity for {line.variant.label} must be more than zero.", "bad_quantity")
        if not line.variant.product.allow_fractions and line.quantity != line.quantity.to_integral_value():
            raise StockError(f"{line.variant.label} is counted in whole {line.variant.product.unit}.", "bad_quantity")


def _require(condition, message, code="not_allowed"):
    if not condition:
        raise StockError(message, code)


def _after_commit_low_stock(levels):
    """Queue low-stock alerts once the transaction has committed."""
    low = [lv for lv in levels if lv.is_low]
    if low:
        from messaging.notify import low_stock_alert

        ids = [lv.pk for lv in low]
        transaction.on_commit(lambda: low_stock_alert(ids))


def _notify(fn_name, *args):
    from messaging import notify

    transaction.on_commit(lambda: getattr(notify, fn_name)(*args))


# ----------------------------------------------------------------------------- receipts
@transaction.atomic
def post_receipt(receipt: Receipt, user):
    receipt = Receipt.objects.select_for_update().get(pk=receipt.pk)
    _require(receipt.status == Receipt.Status.DRAFT, f"{receipt.code} has already been {receipt.get_status_display().lower()}.")
    _require(user.can_manage(receipt.location), "Only an admin or this store's manager can receive stock.")
    lines = list(receipt.lines.select_related("variant__product"))
    _require(lines, "Add at least one product before receiving.")
    _check_qty(lines)
    levels = _lock_levels([(receipt.location_id, l.variant_id) for l in lines])
    for line in lines:
        _update_average_cost(line.variant, line.quantity, line.unit_cost)
        _apply(levels[(receipt.location_id, line.variant_id)], line.quantity, K.RECEIPT, receipt.code, user,
               line.unit_cost, f"From {receipt.supplier.name}")
        line.variant.product.suppliers.add(receipt.supplier)  # next delivery lists this supplier's products first
    receipt.status = Receipt.Status.POSTED
    receipt.posted_at = timezone.now()
    receipt.save(update_fields=["status", "posted_at", "updated_at"])
    _notify("receipt_posted", receipt.pk)
    return receipt


def _update_average_cost(variant, qty, unit_cost):
    """Weighted average cost across all locations, so stock value and profit stay realistic."""
    if not unit_cost:
        return
    variant = Variant.objects.select_for_update().get(pk=variant.pk)
    on_hand = sum((lv.quantity for lv in variant.levels.all()), ZERO)
    total_qty = on_hand + qty
    if total_qty > 0:
        variant.cost_price = ((on_hand * variant.cost_price) + (qty * unit_cost)) / total_qty
        variant.save(update_fields=["cost_price", "updated_at"])


@transaction.atomic
def void_receipt(receipt: Receipt, user, reason=""):
    receipt = Receipt.objects.select_for_update().get(pk=receipt.pk)
    _require(user.is_admin, "Only an admin can void a delivery.")
    _require(receipt.status == Receipt.Status.POSTED, "Only received deliveries can be voided.")
    lines = list(receipt.lines.select_related("variant__product"))
    levels = _lock_levels([(receipt.location_id, l.variant_id) for l in lines])
    for line in lines:
        _apply(levels[(receipt.location_id, line.variant_id)], -line.quantity, K.RECEIPT_VOID, receipt.code, user,
               line.unit_cost, reason or "Delivery voided")
    receipt.status = Receipt.Status.VOID
    receipt.notes = (receipt.notes + f"\nVoided: {reason}").strip()
    receipt.save(update_fields=["status", "notes", "updated_at"])
    return receipt


# ----------------------------------------------------------------------------- transfers
def create_transfer_status(transfer: Transfer, user):
    """Admins' transfers are approved immediately; managers' need the admin."""
    _require(transfer.source_id != transfer.destination_id, "Choose two different locations.")
    _require(transfer.source.business_id == transfer.destination.business_id == user.business_id,
             "Both stores must belong to your business.")
    _require(user.can_access(transfer.source) or user.can_access(transfer.destination),
             "You can only request transfers for your own stores.")
    set_driver(transfer, {})
    if user.is_admin:
        transfer.status = Transfer.Status.APPROVED
        transfer.approved_by = user
        transfer.approved_at = timezone.now()
    return transfer


@transaction.atomic
def approve_transfer(transfer: Transfer, user):
    transfer = Transfer.objects.select_for_update().get(pk=transfer.pk)
    _require(user.is_admin, "Only an admin can approve transfers.")
    _require(transfer.status == Transfer.Status.REQUESTED, f"{transfer.code} is {transfer.get_status_display().lower()}.")
    _check_available(transfer.source, transfer.lines.select_related("variant__product"))
    transfer.status = Transfer.Status.APPROVED
    transfer.approved_by, transfer.approved_at = user, timezone.now()
    transfer.save()
    _notify("transfer_changed", transfer.pk, "approved")
    return transfer


@transaction.atomic
def reject_transfer(transfer: Transfer, user, reason=""):
    transfer = Transfer.objects.select_for_update().get(pk=transfer.pk)
    _require(user.is_admin, "Only an admin can reject transfers.")
    _require(transfer.status in (Transfer.Status.REQUESTED, Transfer.Status.APPROVED), "This transfer can no longer be rejected.")
    transfer.status = Transfer.Status.REJECTED
    transfer.rejection_reason = reason[:255]
    transfer.save()
    _notify("transfer_changed", transfer.pk, "rejected")
    return transfer


@transaction.atomic
def cancel_transfer(transfer: Transfer, user):
    transfer = Transfer.objects.select_for_update().get(pk=transfer.pk)
    _require(user.is_admin or transfer.created_by_id == user.pk, "Only the person who asked, or an admin, can cancel.")
    _require(transfer.status in (Transfer.Status.REQUESTED, Transfer.Status.APPROVED), "Goods already left; receive them instead.")
    transfer.status = Transfer.Status.CANCELLED
    transfer.save()
    return transfer


def set_driver(transfer: Transfer, driver: dict | None):
    """Copy driver / vehicle details onto the transfer (blank values keep what was entered before)."""
    from accounts.models import normalize_phone

    for field in ("driver_name", "driver_phone", "vehicle_type", "vehicle_reg"):
        value = (driver or {}).get(field)
        if value not in (None, ""):
            setattr(transfer, field, str(value).strip())
    transfer.driver_phone = normalize_phone(transfer.driver_phone) if transfer.driver_phone else ""
    transfer.vehicle_reg = re.sub(r"\s+", " ", (transfer.vehicle_reg or "").upper()).strip()


def _check_driver(transfer: Transfer):
    _require(transfer.driver_name.strip(), "Enter the name of the person taking the goods.", "driver_required")
    _require(len(transfer.driver_phone) >= 12, "Enter the driver's phone number (e.g. 0712 345 678).", "driver_required")
    _require(transfer.vehicle_type in Vehicle.values, "Choose how the goods are travelling (tuk-tuk, motorbike …).", "driver_required")


@transaction.atomic
def dispatch_transfer(transfer: Transfer, user, driver: dict | None = None):
    """Goods physically leave the source: stock goes down there and is 'on the way'.

    The driver's name, phone and vehicle type are required. The vehicle registration is optional.
    """
    transfer = Transfer.objects.select_for_update().get(pk=transfer.pk)
    _require(transfer.status == Transfer.Status.APPROVED, "Only approved transfers can be dispatched.")
    _require(user.can_manage(transfer.source), f"Only the {transfer.source.name} manager or an admin can dispatch.")
    set_driver(transfer, driver)
    _check_driver(transfer)
    lines = list(transfer.lines.select_related("variant__product"))
    _check_qty(lines)
    levels = _lock_levels([(transfer.source_id, l.variant_id) for l in lines])
    for line in lines:
        _apply(levels[(transfer.source_id, line.variant_id)], -line.quantity, K.TRANSFER_OUT, transfer.code, user,
               line.variant.cost_price, f"To {transfer.destination.name}")
    transfer.status = Transfer.Status.IN_TRANSIT
    transfer.dispatched_by, transfer.dispatched_at = user, timezone.now()
    transfer.tracking_token = transfer.tracking_token or secrets.token_urlsafe(16)
    transfer.save()
    _after_commit_low_stock(levels.values())
    _notify("transfer_changed", transfer.pk, "dispatched")
    return transfer


@transaction.atomic
def receive_transfer(transfer: Transfer, user, received: dict | None = None):
    """
    Goods arrive at the destination. `received` maps line id → quantity actually counted on arrival.
    Missing lines default to the full dispatched quantity. Shortages are recorded and the admin is alerted.
    """
    transfer = Transfer.objects.select_for_update().get(pk=transfer.pk)
    _require(transfer.status == Transfer.Status.IN_TRANSIT, "Only transfers in transit can be received.")
    _require(user.can_manage(transfer.destination) or (user.can_access(transfer.destination)),
             f"Only {transfer.destination.name} staff or an admin can receive this.")
    received = {int(k): Decimal(str(v)) for k, v in (received or {}).items()}
    lines = list(transfer.lines.select_related("variant__product"))
    levels = _lock_levels([(transfer.destination_id, l.variant_id) for l in lines])
    for line in lines:
        qty = received.get(line.id, line.quantity)
        _require(ZERO <= qty <= line.quantity, f"Received quantity for {line.variant.label} must be between 0 and {line.quantity:g}.")
        line.received_quantity = qty
        line.save(update_fields=["received_quantity"])
        if qty > 0:
            _apply(levels[(transfer.destination_id, line.variant_id)], qty, K.TRANSFER_IN, transfer.code, user,
                   line.variant.cost_price, f"From {transfer.source.name}")
    transfer.status = Transfer.Status.RECEIVED
    transfer.received_by, transfer.received_at = user, timezone.now()
    transfer.save()
    _notify("transfer_changed", transfer.pk, "received")
    return transfer


# ----------------------------------------------------------------------------- live tracking
ARRIVAL_RADIUS_M = 200


def distance_m(lat1, lng1, lat2, lng2):
    """Great-circle distance in metres."""
    lat1, lng1, lat2, lng2 = (math.radians(float(x)) for x in (lat1, lng1, lat2, lng2))
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(a))


@transaction.atomic
def record_track_point(transfer: Transfer, lat, lng, accuracy=None, speed=None, heading=None):
    """A GPS fix from the phone travelling with the goods. Only accepted while they are on the road."""
    transfer = Transfer.objects.select_for_update().select_related("destination").get(pk=transfer.pk)
    _require(transfer.status == Transfer.Status.IN_TRANSIT, "Tracking has ended: these goods are no longer on the way.",
             "tracking_closed")
    _require(transfer.driver_arrived_at is None, "Arrival was already reported; tracking has ended.", "tracking_closed")
    try:
        lat = Decimal(str(lat)).quantize(Decimal("0.000001"))
        lng = Decimal(str(lng)).quantize(Decimal("0.000001"))
    except Exception:
        raise StockError("Invalid GPS position.", "bad_position")
    _require(-90 <= lat <= 90 and -180 <= lng <= 180, "Invalid GPS position.", "bad_position")
    now = timezone.now()
    last = transfer.track_points.order_by("-recorded_at").first()
    if last and (now - last.recorded_at) < timedelta(seconds=3):
        return last  # phones can fire several fixes a second; keep the log small
    point = TrackPoint.objects.create(transfer=transfer, latitude=lat, longitude=lng, accuracy=accuracy, speed=speed,
                                      heading=heading, recorded_at=now)
    dest = transfer.destination
    if not transfer.arrived_near_at and dest.has_map_point:
        if distance_m(lat, lng, dest.latitude, dest.longitude) <= ARRIVAL_RADIUS_M:
            transfer.arrived_near_at = now
            transfer.save(update_fields=["arrived_near_at", "updated_at"])
            _notify("transfer_changed", transfer.pk, "arriving")
    return point


@transaction.atomic
def driver_arrived(transfer: Transfer):
    """Let the driver report arrival, but leave receipt and stock confirmation to destination staff."""
    transfer = Transfer.objects.select_for_update().select_related("destination").get(pk=transfer.pk)
    _require(transfer.status == Transfer.Status.IN_TRANSIT, "This trip is no longer active.")
    if transfer.driver_arrived_at:
        return transfer
    if transfer.destination.has_map_point:
        last = transfer.track_points.order_by("-recorded_at").first()
        _require(last is not None, "Share your location first so arrival can be confirmed.")
        distance = distance_m(last.latitude, last.longitude, transfer.destination.latitude, transfer.destination.longitude)
        _require(distance <= ARRIVAL_RADIUS_M, "You can report arrival only when you are within 200 m of the destination.")
    transfer.driver_arrived_at = timezone.now()
    transfer.save(update_fields=["driver_arrived_at", "updated_at"])
    _notify("transfer_changed", transfer.pk, "driver_arrived")
    return transfer


def tracking_summary(transfer: Transfer):
    """Where the goods are now, how far they still have to go and a rough arrival time."""
    points = list(transfer.track_points.order_by("-recorded_at")[:300])
    points.reverse()
    src, dst = transfer.source, transfer.destination
    last = points[-1] if points else None
    place = lambda l: {"lat": l.latitude, "lng": l.longitude, "name": l.name} if l.has_map_point else None  # noqa: E731
    out = {
        "active": transfer.status == Transfer.Status.IN_TRANSIT and transfer.driver_arrived_at is None,
        "source": place(src),
        "destination": place(dst),
        "points": [{"lat": p.latitude, "lng": p.longitude, "at": p.recorded_at} for p in points],
        "last": None,
        "distance_left_m": None,
        "eta_minutes": None,
        "arrived_near_at": transfer.arrived_near_at,
        "driver_arrived_at": transfer.driver_arrived_at,
    }
    if last:
        out["last"] = {"lat": last.latitude, "lng": last.longitude, "at": last.recorded_at, "speed": last.speed,
                       "accuracy": last.accuracy, "heading": last.heading,
                       "seconds_ago": int((timezone.now() - last.recorded_at).total_seconds())}
        if dst.has_map_point:
            left = distance_m(last.latitude, last.longitude, dst.latitude, dst.longitude)
            out["distance_left_m"] = round(left)
            # Use the phone's speed when moving; otherwise ~15 km/h, typical for a tuk-tuk or boda in town traffic.
            speed = last.speed if last.speed and last.speed > 1.5 else 15 / 3.6
            out["eta_minutes"] = max(1, round(left * 1.3 / speed / 60))  # roads are ~30% longer than a straight line
    return out


def _check_available(location, lines):
    for line in lines:
        level = StockLevel.objects.filter(location=location, variant=line.variant).first()
        available = level.quantity if level else ZERO
        if available < line.quantity:
            raise InsufficientStock(line.variant, location, available, line.quantity)


# ----------------------------------------------------------------------------- removal / addition requests
def initial_request_status(req: StockRequest, user, already_done=False):
    """
    Admin asks → PENDING (manager must act and confirm).
    Manager reports something already done ('REMOVED …') → CONFIRMED (admin must approve).
    """
    _require(user.can_access(req.location), "You don't work at this location.")
    if already_done and user.can_manage(req.location):
        req.status = StockRequest.Status.CONFIRMED
        req.confirmed_by, req.confirmed_at = user, timezone.now()
    else:
        req.status = StockRequest.Status.PENDING
    return req


def after_request_created(req: StockRequest):
    _notify("request_changed", req.pk, req.status)


@transaction.atomic
def confirm_request(req: StockRequest, user, confirmed: dict | None = None):
    """Stock manager confirms the goods were physically removed/added (optionally with different quantities)."""
    req = StockRequest.objects.select_for_update().get(pk=req.pk)
    _require(req.status == StockRequest.Status.PENDING, f"{req.code} is {req.get_status_display().lower()}.")
    _require(user.can_manage(req.location), f"Only the {req.location.name} manager or an admin can confirm.")
    confirmed = {int(k): Decimal(str(v)) for k, v in (confirmed or {}).items()}
    for line in req.lines.all():
        qty = confirmed.get(line.id, line.quantity)
        _require(qty >= 0, "Quantities can't be negative.")
        line.confirmed_quantity = qty
        line.save(update_fields=["confirmed_quantity"])
    req.status = StockRequest.Status.CONFIRMED
    req.confirmed_by, req.confirmed_at = user, timezone.now()
    req.save()
    _notify("request_changed", req.pk, req.status)
    return req


@transaction.atomic
def approve_request(req: StockRequest, user):
    """Admin approval: this is the moment stock actually changes."""
    req = StockRequest.objects.select_for_update().get(pk=req.pk)
    _require(user.is_admin, "Only an admin can approve stock changes.")
    if req.status == StockRequest.Status.PENDING and req.created_by_id == user.pk:
        # The admin asked for it AND is approving it: treat as confirmed by the admin.
        req.confirmed_by, req.confirmed_at = user, timezone.now()
    else:
        _require(req.status == StockRequest.Status.CONFIRMED,
                 "Wait for the stock manager to confirm the goods were moved before approving.")
    lines = [l for l in req.lines.select_related("variant__product") if l.final_quantity > 0]
    _require(lines, "Nothing to change: all quantities are zero.")
    sign = -1 if req.kind == StockRequest.Kind.REMOVE else 1
    kind = K.REMOVAL if sign < 0 else K.ADDITION
    levels = _lock_levels([(req.location_id, l.variant_id) for l in lines])
    for line in lines:
        _apply(levels[(req.location_id, line.variant_id)], sign * line.final_quantity, kind, req.code, user,
               line.variant.cost_price, req.get_reason_display())
    req.status = StockRequest.Status.APPROVED
    req.approved_by, req.approved_at = user, timezone.now()
    req.save()
    _after_commit_low_stock(levels.values())
    _notify("request_changed", req.pk, req.status)
    return req


@transaction.atomic
def reject_request(req: StockRequest, user, reason=""):
    req = StockRequest.objects.select_for_update().get(pk=req.pk)
    _require(user.is_admin, "Only an admin can reject.")
    _require(req.status in (StockRequest.Status.PENDING, StockRequest.Status.CONFIRMED), "This request is already closed.")
    req.status = StockRequest.Status.REJECTED
    req.rejection_reason = reason[:255]
    req.save()
    _notify("request_changed", req.pk, req.status)
    return req


@transaction.atomic
def cancel_request(req: StockRequest, user):
    req = StockRequest.objects.select_for_update().get(pk=req.pk)
    _require(user.is_admin or req.created_by_id == user.pk, "Only the requester or an admin can cancel.")
    _require(req.status in (StockRequest.Status.PENDING, StockRequest.Status.CONFIRMED), "This request is already closed.")
    req.status = StockRequest.Status.CANCELLED
    req.save()
    return req


# ----------------------------------------------------------------------------- sales
MPESA_CODE = re.compile(r"^[A-Z0-9]{10}$")


@transaction.atomic
def post_sale(sale: Sale, user, mpesa_payment_id=None, deposit=None):
    """
    Take the goods off the shelf and settle the money:
      cash / card / bank → paid in full now
      M-Pesa             → the customer's confirmation code typed in, or a paid STK prompt sent to their phone
      credit             → named customer with phone; optional deposit; respects the customer's credit limit
    """
    _require(sale.location.can_sell,
             f"Selling is switched off at {sale.location.name}. An admin can switch it on in the store's settings.")
    _require(user.can_access(sale.location), "You don't work at this store.")
    lines = list(sale.lines.select_related("variant__product"))
    _require(lines, "A sale needs at least one item.")
    _check_qty(lines)
    for line in lines:
        _require(line.variant.product.business_id == sale.location.business_id, "That product isn't in your catalogue.")
        _require(line.unit_price >= 0, "Prices can't be negative.")
    _require(ZERO <= sale.discount <= sale.subtotal, "Discount can't be more than the total.")
    total = sale.total
    method = sale.payment_method

    if method == Sale.Payment.CREDIT:
        _require(sale.customer_id, "Credit sales need the customer's name and phone number.", "customer_required")
        deposit = Decimal(str(deposit or 0))
        _require(ZERO <= deposit < total, "A deposit must be less than the total; otherwise it isn't a credit sale.")
        customer = sale.customer
        if customer.credit_limit > 0:
            owed = customer.outstanding(exclude_sale=sale)
            _require(owed + total - deposit <= customer.credit_limit,
                     f"This sale would exceed {customer.name}'s credit limit. "
                     "Take a bigger deposit or update the credit limit.", "credit_limit")
        sale.amount_paid = deposit
        sale.due_date = sale.due_date or (timezone.localdate() + timedelta(days=14))
        paid_with = Sale.Payment.CASH
    elif method == Sale.Payment.MPESA:
        if mpesa_payment_id:
            mp = (MpesaPayment.objects.select_for_update()
                  .filter(pk=mpesa_payment_id, business_id=sale.location.business_id).first())
            _require(mp is not None, "That M-Pesa payment wasn't found.")
            _require(mp.status == MpesaPayment.Status.SUCCESS, "The customer hasn't completed the M-Pesa payment yet.", "mpesa_pending")
            _require(mp.sale_id is None, f"M-Pesa payment {mp.receipt_number} is already used on another sale.", "mpesa_used")
            _require(mp.amount >= total, f"M-Pesa received KES {mp.amount:,.0f} but the sale is KES {total:,.0f}.", "mpesa_short")
            mp.sale = sale
            mp.save(update_fields=["sale", "updated_at"])
            sale.payment_reference = mp.receipt_number
        else:
            code = re.sub(r"\s+", "", sale.payment_reference or "").upper()
            _require(MPESA_CODE.match(code),
                     "Enter the 10-character M-Pesa code from the customer's message (e.g. SKL4ABCD12).", "mpesa_code")
            used = (Sale.objects.filter(location__business_id=sale.location.business_id, payment_reference=code,
                                        status=Sale.Status.COMPLETED).exclude(pk=sale.pk).first())
            _require(used is None, f"M-Pesa code {code} was already used on {used.code if used else ''}.", "mpesa_used")
            from . import mpesa

            business = sale.location.business
            if mpesa.code_check_enabled(business):
                mpesa.claim_code(business, code, total, sale=sale, used_for=sale.code)  # must be a real payment
            sale.payment_reference = code
        sale.amount_paid = total
        paid_with = method
    else:
        sale.amount_paid = total
        paid_with = method

    levels = _lock_levels([(sale.location_id, l.variant_id) for l in lines])
    for line in lines:
        _apply(levels[(sale.location_id, line.variant_id)], -line.quantity, K.SALE, sale.code, user, line.unit_cost)
    sale.save(update_fields=["amount_paid", "due_date", "payment_reference", "updated_at"])
    if sale.amount_paid > 0:
        SalePayment.objects.create(sale=sale, amount=sale.amount_paid, method=paid_with,
                                   reference=sale.payment_reference, received_by=user)
    _after_commit_low_stock(levels.values())
    return sale


@transaction.atomic
def record_sale_payment(sale: Sale, user, amount, method="cash", reference=""):
    """The customer pays all or part of a credit sale."""
    sale = Sale.objects.select_for_update().get(pk=sale.pk)
    _require(user.can_access(sale.location), "You don't work at this store.")
    _require(sale.status == Sale.Status.COMPLETED, "This sale was voided.")
    try:
        amount = Decimal(str(amount or 0))
    except Exception:
        raise StockError("Enter the amount received.", "bad_amount")
    _require(amount > 0, "Enter the amount received.")
    _require(amount <= sale.balance, f"Only KES {sale.balance:,.0f} is still owed on {sale.code}.")
    _require(method in Sale.Payment.values and method != Sale.Payment.CREDIT, "Choose how the customer paid.")
    reference = re.sub(r"\s+", "", reference or "").upper()
    if method == Sale.Payment.MPESA:
        _require(MPESA_CODE.match(reference), "Enter the 10-character M-Pesa code.", "mpesa_code")
        from . import mpesa

        business = sale.location.business
        if mpesa.code_check_enabled(business):
            mpesa.claim_code(business, reference, amount, sale=sale, used_for=f"{sale.code} payment")
        else:
            _require(not SalePayment.objects.filter(sale__location__business_id=business.id, reference=reference).exists()
                     and not Sale.objects.filter(location__business_id=business.id, payment_reference=reference).exists(),
                     f"M-Pesa code {reference} was already used.", "mpesa_used")
    sale.amount_paid += amount
    sale.save(update_fields=["amount_paid", "updated_at"])
    SalePayment.objects.create(sale=sale, amount=amount, method=method, reference=reference, received_by=user)
    return sale


@transaction.atomic
def void_sale(sale: Sale, user, reason=""):
    sale = Sale.objects.select_for_update().get(pk=sale.pk)
    _require(user.is_admin or (user.can_manage(sale.location) and (timezone.now() - sale.created_at).days < 1),
             "Managers can void sales on the same day; older sales need an admin.")
    _require(sale.status == Sale.Status.COMPLETED, "This sale is already void.")
    lines = list(sale.lines.select_related("variant__product"))
    levels = _lock_levels([(sale.location_id, l.variant_id) for l in lines])
    for line in lines:
        _apply(levels[(sale.location_id, line.variant_id)], line.quantity, K.SALE_VOID, sale.code, user, line.unit_cost, reason)
    sale.status = Sale.Status.VOID
    sale.void_reason = reason[:255]
    sale.save()
    return sale


# ----------------------------------------------------------------------------- stocktake
@transaction.atomic
def start_count(location: Location, user, variant_ids=None, notes=""):
    _require(user.can_manage(location), "Only a manager or admin can start a stocktake.")
    count = StockCount.objects.create(location=location, created_by=user, notes=notes)
    levels = StockLevel.objects.filter(location=location)
    if variant_ids:
        levels = levels.filter(variant_id__in=variant_ids)
    StockCountLine.objects.bulk_create(
        [StockCountLine(count=count, variant_id=lv.variant_id, expected=lv.quantity) for lv in levels])
    return count


@transaction.atomic
def submit_count(count: StockCount, user):
    count = StockCount.objects.select_for_update().get(pk=count.pk)
    _require(count.status == StockCount.Status.OPEN, "This count was already submitted.")
    _require(user.can_manage(count.location), "Only a manager or admin can submit.")
    _require(not count.lines.filter(counted__isnull=True).exists(), "Enter a counted quantity for every item first.")
    count.status = StockCount.Status.SUBMITTED
    count.save()
    _notify("count_submitted", count.pk)
    return count


@transaction.atomic
def post_count(count: StockCount, user):
    """Admin posts: each variance becomes a COUNT movement. Sales since counting are respected by
    applying the variance (counted − expected) rather than overwriting the balance."""
    count = StockCount.objects.select_for_update().get(pk=count.pk)
    _require(user.is_admin, "Only an admin can post a stocktake.")
    _require(count.status == StockCount.Status.SUBMITTED, "Submit the count before posting.")
    lines = [l for l in count.lines.select_related("variant__product") if l.variance]
    levels = _lock_levels([(count.location_id, l.variant_id) for l in lines]) if lines else {}
    for line in lines:
        level = levels[(count.location_id, line.variant_id)]
        variance = line.variance if level.quantity + line.variance >= 0 else -level.quantity
        _apply(level, variance, K.COUNT, count.code, user, line.variant.cost_price,
               f"Counted {line.counted:g}, system had {line.expected:g}")
    count.status = StockCount.Status.POSTED
    count.posted_by, count.posted_at = user, timezone.now()
    count.save()
    return count


# ----------------------------------------------------------------------------- reporting helpers
def location_summary(location_ids):
    """Per-location totals used by the dashboard and location cards."""
    out = defaultdict(lambda: {"items": 0, "units": ZERO, "value": ZERO, "retail": ZERO, "low": 0, "out": 0})
    levels = StockLevel.objects.filter(location_id__in=location_ids, variant__is_active=True,
                                       variant__product__is_active=True).select_related("variant__product")
    for lv in levels:
        s = out[lv.location_id]
        if lv.quantity > 0:
            s["items"] += 1
            s["units"] += lv.quantity
            s["value"] += lv.quantity * lv.variant.cost_price
            s["retail"] += lv.quantity * lv.variant.selling_price
        if lv.quantity <= 0:
            s["out"] += 1
        elif lv.is_low:
            s["low"] += 1
    return out
