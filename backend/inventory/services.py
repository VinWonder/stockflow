"""
All stock-changing logic lives here. Views and the SMS/WhatsApp handler call these functions;
nothing else touches StockLevel.quantity.

Every public function runs in ONE database transaction and locks the affected StockLevel rows
(SELECT … FOR UPDATE) in a fixed order, so two phones selling the last bag of cement at the
same moment can never drive stock negative or deadlock each other.
"""
from collections import defaultdict
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from .exceptions import InsufficientStock, StockError
from .models import (ZERO, Location, Receipt, Sale, StockCount, StockCountLine, StockLevel, StockMovement,
                     StockRequest, Transfer, Variant)

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
    _require(user.can_access(transfer.source) or user.can_access(transfer.destination),
             "You can only request transfers for your own stores.")
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


@transaction.atomic
def dispatch_transfer(transfer: Transfer, user):
    """Goods physically leave the source: stock goes down there and is 'in transit'."""
    transfer = Transfer.objects.select_for_update().get(pk=transfer.pk)
    _require(transfer.status == Transfer.Status.APPROVED, "Only approved transfers can be dispatched.")
    _require(user.can_manage(transfer.source), f"Only the {transfer.source.name} manager or an admin can dispatch.")
    lines = list(transfer.lines.select_related("variant__product"))
    _check_qty(lines)
    levels = _lock_levels([(transfer.source_id, l.variant_id) for l in lines])
    for line in lines:
        _apply(levels[(transfer.source_id, line.variant_id)], -line.quantity, K.TRANSFER_OUT, transfer.code, user,
               line.variant.cost_price, f"To {transfer.destination.name}")
    transfer.status = Transfer.Status.IN_TRANSIT
    transfer.dispatched_by, transfer.dispatched_at = user, timezone.now()
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
@transaction.atomic
def post_sale(sale: Sale, user):
    _require(sale.location.can_sell, f"{sale.location.name} is a store, not a selling point. Transfer the goods to a shop first.")
    _require(user.can_access(sale.location), "You don't work at this shop.")
    lines = list(sale.lines.select_related("variant__product"))
    _require(lines, "A sale needs at least one item.")
    _check_qty(lines)
    _require(sale.discount <= sale.subtotal, "Discount can't be more than the total.")
    levels = _lock_levels([(sale.location_id, l.variant_id) for l in lines])
    for line in lines:
        line.unit_cost = line.variant.cost_price
        line.save(update_fields=["unit_cost"])
        _apply(levels[(sale.location_id, line.variant_id)], -line.quantity, K.SALE, sale.code, user, line.unit_cost)
    _after_commit_low_stock(levels.values())
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
    out = defaultdict(lambda: {"items": 0, "units": ZERO, "value": ZERO, "low": 0, "out": 0})
    for lv in StockLevel.objects.filter(location_id__in=location_ids).select_related("variant__product"):
        s = out[lv.location_id]
        if lv.quantity > 0:
            s["items"] += 1
            s["units"] += lv.quantity
            s["value"] += lv.quantity * lv.variant.cost_price
        if lv.quantity <= 0:
            s["out"] += 1
        elif lv.is_low:
            s["low"] += 1
    return out
