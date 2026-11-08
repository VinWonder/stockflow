"""Turn an incoming SMS / WhatsApp message into stock actions and a reply text."""
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q

from accounts.models import normalize_phone
from inventory import services
from inventory.exceptions import StockError
from inventory.models import Location, StockLevel, StockRequest, StockRequestLine, Transfer, TransferLine, Variant

from .models import MessageLog
from .parser import HELP_TEXT, parse

User = get_user_model()


class Unresolved(Exception):
    pass


def resolve_variant(tokens):
    """SKU match first; otherwise product code + size/colour words. Raises Unresolved with a helpful hint."""
    joined = "-".join(tokens)
    for sku in (joined, tokens[0]):
        v = Variant.objects.filter(sku__iexact=sku, is_active=True).select_related("product").first()
        if v:
            return v
    v = Variant.objects.filter(barcode=tokens[0], is_active=True).first()
    if v:
        return v
    code, attrs = tokens[0], [t.lower() for t in tokens[1:]]
    candidates = list(Variant.objects.filter(product__code__iexact=code, is_active=True).select_related("product"))
    if not candidates:
        candidates = list(Variant.objects.filter(product__name__icontains=code, is_active=True).select_related("product")[:20])
    if not candidates:
        raise Unresolved(f"'{' '.join(tokens)}' not found")

    def score(v):
        words = f"{v.size} {v.colour}".lower().replace("-", " ").split()
        return sum(1 for a in attrs if a in words or a in v.sku.lower())

    if attrs:
        scored = sorted(candidates, key=score, reverse=True)
        best = score(scored[0])
        top = [v for v in scored if score(v) == best]
        if best == len(attrs) and len(top) == 1:
            return top[0]
        if best > 0 and len(top) == 1:
            return top[0]
        candidates = top
    if len(candidates) == 1:
        return candidates[0]
    options = ", ".join(v.sku for v in candidates[:5])
    raise Unresolved(f"'{' '.join(tokens)}' has several sizes/colours. Use one of: {options}")


def _location(code, user):
    loc = Location.objects.filter(code__iexact=code, is_active=True).first()
    if not loc:
        codes = ", ".join(Location.objects.filter(id__in=user.accessible_location_ids()).values_list("code", flat=True))
        raise Unresolved(f"No store called '{code}'. Your stores: {codes}")
    if not user.can_access(loc):
        raise Unresolved(f"You are not assigned to {loc.name}.")
    return loc


def handle_incoming(channel, phone, text, provider_id=""):
    phone = normalize_phone(phone)
    if provider_id and MessageLog.objects.filter(direction="in", provider_id=provider_id).exists():
        return None  # provider retried the webhook: already handled
    user = User.objects.filter(phone=phone, is_active=True).first()
    entry = MessageLog.objects.create(direction="in", channel=channel, phone=phone, body=text[:1600], user=user,
                                      provider_id=provider_id)
    if not user:
        entry.status, entry.result = "rejected", "unknown phone"
        entry.save()
        return None  # never reply to strangers (avoids leaking stock data and SMS costs)
    try:
        reply, result = execute(user, text, channel)
    except (Unresolved, StockError, PermissionError) as exc:
        reply, result = f"Not done: {getattr(exc, 'message', str(exc))}", "error"
        entry.status = "error"
    entry.result = result[:255]
    entry.save()
    from .gateways import send

    send(channel, phone, reply, user)
    return reply


def execute(user, text, channel):
    cmd = parse(text)
    if not cmd.ok:
        return "Not understood:\n" + "\n".join(cmd.errors[:3]) + "\nSend HELP for examples.", "parse error"
    if cmd.action == "help":
        return HELP_TEXT, "help"
    if cmd.action == "stock":
        return _stock_query(user, cmd), "stock query"
    if cmd.action in ("confirm", "approve", "reject"):
        return _act_on_reference(user, cmd)

    source = _location(cmd.location, user)
    items, problems = [], []
    for item in cmd.items:
        try:
            items.append((resolve_variant(item.tokens), item.quantity))
        except Unresolved as exc:
            problems.append(str(exc))
    if problems:
        return "Not done:\n" + "\n".join(problems[:4]), "unresolved items"

    with transaction.atomic():
        if cmd.action == "transfer":
            dest = Location.objects.filter(code__iexact=cmd.destination, is_active=True).first()
            if not dest:
                raise Unresolved(f"No store called '{cmd.destination}'.")
            t = Transfer(source=source, destination=dest, created_by=user, notes=f"Via {channel}: {text[:200]}")
            services.create_transfer_status(t, user)
            t.save()
            TransferLine.objects.bulk_create([TransferLine(transfer=t, variant=v, quantity=q) for v, q in items])
            event = "approved" if t.status == Transfer.Status.APPROVED else "requested"
            from . import notify

            transaction.on_commit(lambda: notify.transfer_changed(t.pk, event))
            state = "approved, ready to dispatch" if event == "approved" else "sent to admin for approval"
            return f"{t.code} created: {source.code}>{dest.code}, {len(items)} item(s), {state}.", f"created {t.code}"

        req = StockRequest(kind=cmd.action, location=source, reason=cmd.reason, created_by=user,
                           source=channel, raw_message=text[:1000], sender_phone=user.phone,
                           notes=cmd.reason_text)
        services.initial_request_status(req, user, already_done=cmd.already_done)
        req.save()
        StockRequestLine.objects.bulk_create([
            StockRequestLine(request=req, variant=v, quantity=q,
                             confirmed_quantity=q if req.status == StockRequest.Status.CONFIRMED else None)
            for v, q in items])
        if cmd.action == "remove":
            for v, q in items:
                level = StockLevel.objects.filter(location=source, variant=v).first()
                have = level.quantity if level else 0
                if have < q:
                    raise Unresolved(f"{v.sku}: only {have:g} at {source.code}, can't remove {q:g}.")
        transaction.on_commit(lambda: services.after_request_created(req))
    summary = ", ".join(f"{v.sku}×{q:g}" for v, q in items)
    if req.status == StockRequest.Status.CONFIRMED:
        return f"{req.code} logged ({summary}). Waiting for admin approval.", f"created {req.code}"
    return (f"{req.code} created ({summary}). The {source.code} manager has been asked; "
            f"reply CONFIRM {req.code} when done."), f"created {req.code}"


def _act_on_reference(user, cmd):
    prefix = cmd.reference[:3].rstrip("0123456789")
    if prefix == "SR":
        req = StockRequest.objects.filter(code=cmd.reference).select_related("location").first()
        if not req:
            raise Unresolved(f"{cmd.reference} not found.")
        if cmd.action == "confirm":
            services.confirm_request(req, user)
            return f"{req.code} confirmed. Admin will approve.", f"confirmed {req.code}"
        if cmd.action == "approve":
            services.approve_request(req, user)
            return f"{req.code} approved. Stock at {req.location.code} updated.", f"approved {req.code}"
        services.reject_request(req, user, cmd.reason_text)
        return f"{req.code} rejected.", f"rejected {req.code}"
    if prefix == "TRF":
        t = Transfer.objects.filter(code=cmd.reference).first()
        if not t:
            raise Unresolved(f"{cmd.reference} not found.")
        if cmd.action == "approve":
            services.approve_transfer(t, user)
            return f"{t.code} approved.", f"approved {t.code}"
        if cmd.action == "reject":
            services.reject_transfer(t, user, cmd.reason_text)
            return f"{t.code} rejected.", f"rejected {t.code}"
        raise Unresolved("Dispatch and receive transfers in the app so quantities can be counted.")
    raise Unresolved(f"I can't act on {cmd.reference} by message. Use the app.")


def _stock_query(user, cmd):
    tokens = cmd.query_tokens
    locations = Location.objects.filter(id__in=user.accessible_location_ids(), is_active=True)
    loc = locations.filter(code__iexact=tokens[0]).first() if len(tokens) > 1 else None
    if len(tokens) > 1 and not loc and Location.objects.filter(code__iexact=tokens[0]).exists():
        raise Unresolved(f"You are not assigned to {tokens[0]}.")
    if loc:
        tokens = tokens[1:]
        locations = [loc]
    try:
        variants = [resolve_variant(tokens)]
    except Unresolved:
        variants = list(Variant.objects.filter(Q(product__code__iexact=tokens[0]) | Q(sku__istartswith=tokens[0]))[:6])
        if not variants:
            raise
    lines = []
    for v in variants:
        levels = StockLevel.objects.filter(variant=v, location__in=locations).select_related("location")
        parts = ", ".join(f"{lv.location.code} {lv.quantity:g}" for lv in levels) or "none"
        lines.append(f"{v.sku}: {parts}")
    return "\n".join(lines)
