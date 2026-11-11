"""Who gets told what. Called after the stock transaction commits."""
from django.contrib.auth import get_user_model
from django.db.models import Q

from .gateways import send
from .models import Notification

User = get_user_model()


def admins(business_id):
    return User.objects.filter(Q(role="admin") | Q(is_superuser=True), business_id=business_id, is_active=True)


def managers_of(location):
    return User.objects.filter(is_active=True, role="manager", locations=location)


def push(users, kind, title, body, ref_type="", ref_id=None, needs_action=False, exclude=None):
    users = {u.pk: u for u in users if u and (exclude is None or u.pk != exclude.pk)}.values()
    Notification.objects.bulk_create([
        Notification(user=u, kind=kind, title=title[:120], body=body[:500], ref_type=ref_type, ref_id=ref_id,
                     needs_action=needs_action) for u in users])
    for u in users:
        text = f"{title}\n{body}"
        if u.sms_alerts and u.phone:
            send("sms", u.phone, text[:459], u)
        if u.whatsapp_alerts and u.phone:
            send("whatsapp", u.phone, text, u)


def _lines(doc, qty_attr="quantity"):
    return ", ".join(f"{l.variant.label} × {getattr(l, qty_attr) or l.quantity:g}" for l in doc.lines.select_related("variant__product")[:6])


def transfer_changed(transfer_id, event):
    from inventory.models import Transfer

    t = Transfer.objects.select_related("source", "destination", "created_by").get(pk=transfer_id)
    route = f"{t.source.name} → {t.destination.name}"
    biz = t.source.business_id
    driver = f" Driver: {t.driver_name} (+{t.driver_phone})" if t.driver_name and t.driver_phone else ""
    vehicle = f", {t.get_vehicle_type_display()} {t.vehicle_reg}".rstrip() if t.vehicle_type else ""
    if event == "requested":
        push(admins(biz), "transfer", f"Transfer {t.code} needs approval", f"{route}: {_lines(t)}", "transfer", t.pk, True)
    elif event == "approved":
        push(list(managers_of(t.source)) + [t.created_by], "transfer", f"Transfer {t.code} approved",
             f"Dispatch from {t.source.name}: {_lines(t)}", "transfer", t.pk, True)
    elif event == "dispatched":
        push(list(managers_of(t.destination)) + list(User.objects.filter(locations=t.destination, is_active=True)),
             "transfer", f"Incoming: {t.code} is on the way",
             f"{route}: {_lines(t)}.{driver}{vehicle}. Count and receive it on arrival.", "transfer", t.pk, True)
        push(admins(biz), "transfer", f"{t.code} dispatched", f"{route}.{driver}{vehicle}", "transfer", t.pk)
    elif event == "arriving":
        people = list(User.objects.filter(locations=t.destination, is_active=True)) + list(admins(biz))
        push(people, "transfer", f"{t.code} is arriving at {t.destination.name}",
             f"The vehicle is less than 200 m away.{driver}{vehicle}. Get ready to count the goods.", "transfer", t.pk, True)
    elif event == "driver_arrived":
        people = list(User.objects.filter(locations=t.destination, is_active=True)) + list(admins(biz))
        push(people, "transfer", f"{t.code} has arrived at {t.destination.name}",
             f"The driver reports the goods have arrived. Please confirm receipt and count the items.{driver}{vehicle}",
             "transfer", t.pk, True)
    elif event == "received":
        short = [l for l in t.lines.select_related("variant__product") if l.shortage]
        if short:
            detail = ", ".join(f"{l.variant.label} short by {l.shortage:g}" for l in short)
            push(admins(biz), "transfer", f"⚠ {t.code} arrived short", f"{route}: {detail}.{driver}", "transfer", t.pk, True)
        else:
            push(admins(biz), "transfer", f"{t.code} received in full", route, "transfer", t.pk)
        push(managers_of(t.source), "transfer", f"{t.code} received at {t.destination.name}", "", "transfer", t.pk)
    elif event == "rejected":
        push([t.created_by], "transfer", f"Transfer {t.code} rejected", t.rejection_reason or route, "transfer", t.pk)


def request_changed(request_id, status):
    from inventory.models import StockRequest

    r = StockRequest.objects.select_related("location", "created_by").get(pk=request_id)
    verb = "Remove" if r.kind == "remove" else "Add"
    if status == "pending":
        reason = r.get_reason_display()
        if r.notes:
            reason += f": {r.notes}"
        push(managers_of(r.location), "request", f"{verb} stock at {r.location.name} ({r.code})",
             f"{_lines(r)}. Reason: {reason}. Confirm when done.", "request", r.pk, True,
             exclude=r.created_by)
        if not r.created_by or not r.created_by.is_admin:
            push(admins(r.location.business_id), "request", f"New request {r.code}", f"{verb} at {r.location.name}: {_lines(r)}", "request", r.pk)
    elif status == "confirmed":
        reason = r.get_reason_display()
        if r.notes:
            reason += f": {r.notes}"
        push(admins(r.location.business_id), "request", f"Approve {r.code}: {verb.lower()}d at {r.location.name}",
             f"{_lines(r, 'confirmed_quantity')}. Reason: {reason}.", "request", r.pk, True)
    elif status in ("approved", "rejected"):
        people = [r.created_by, r.confirmed_by]
        text = "Stock has been updated." if status == "approved" else (r.rejection_reason or "Rejected by admin.")
        push(people, "request", f"{r.code} {status}", text, "request", r.pk)


def receipt_posted(receipt_id):
    from inventory.models import Receipt

    rc = Receipt.objects.select_related("location", "supplier", "created_by").get(pk=receipt_id)
    push(admins(rc.location.business_id), "receipt", f"Delivery {rc.code} received at {rc.location.name}",
         f"From {rc.supplier.name}: {_lines(rc)}", "receipt", rc.pk, exclude=rc.created_by)


def count_submitted(count_id):
    from inventory.models import StockCount

    c = StockCount.objects.select_related("location").get(pk=count_id)
    diffs = sum(1 for l in c.lines.all() if l.variance)
    push(admins(c.location.business_id), "count", f"Stocktake {c.code} ready to post", f"{c.location.name}: {diffs} item(s) differ from the system.",
         "count", c.pk, True)


def low_stock_alert(level_ids):
    from inventory.models import StockLevel

    for lv in StockLevel.objects.filter(pk__in=level_ids).select_related("location", "variant__product"):
        # one unread alert per item per store is enough
        if Notification.objects.filter(kind="low_stock", ref_type="level", ref_id=lv.pk, is_read=False).exists():
            continue
        state = "OUT OF STOCK" if lv.quantity <= 0 else f"only {lv.quantity:g} {lv.variant.product.unit} left"
        title = f"Out of stock at {lv.location.name}" if lv.quantity <= 0 else f"Low stock at {lv.location.name}"
        push(list(admins(lv.location.business_id)) + list(managers_of(lv.location)), "low_stock", title,
             f"{lv.variant.label}: {state}", "level", lv.pk, True)
