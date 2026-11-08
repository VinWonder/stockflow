import hmac

from django.conf import settings
from django.http import HttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST
from rest_framework import mixins, viewsets
from rest_framework.decorators import action, api_view
from rest_framework.response import Response

from .handler import execute, handle_incoming
from .models import MessageLog, Notification
from .parser import HELP_TEXT

CFG = settings.MESSAGING


class NotificationViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    filterset_fields = ["is_read", "kind", "needs_action"]

    def get_queryset(self):
        return Notification.objects.filter(user=self.request.user)

    def list(self, request, *args, **kwargs):
        page = self.paginate_queryset(self.filter_queryset(self.get_queryset()))
        data = [{"id": n.id, "kind": n.kind, "title": n.title, "body": n.body, "ref_type": n.ref_type,
                 "ref_id": n.ref_id, "needs_action": n.needs_action, "is_read": n.is_read,
                 "created_at": n.created_at} for n in page]
        return self.get_paginated_response(data)

    @action(detail=False)
    def unread(self, request):
        qs = self.get_queryset().filter(is_read=False)
        return Response({"count": qs.count(), "action_needed": qs.filter(needs_action=True).count()})

    @action(detail=True, methods=["post"])
    def read(self, request, pk=None):
        self.get_queryset().filter(pk=pk).update(is_read=True)
        return Response({"ok": True})

    @action(detail=False, methods=["post"])
    def read_all(self, request):
        n = self.get_queryset().filter(is_read=False).update(is_read=True)
        return Response({"marked": n})


@api_view(["GET"])
def messaging_config(request):
    """What the app needs to open WhatsApp / SMS on the phone with a ready-made command."""
    return Response({
        "sms_number": CFG["BUSINESS_SMS_NUMBER"],
        "whatsapp_number": CFG["BUSINESS_WHATSAPP_NUMBER"],
        "help": HELP_TEXT,
        "your_phone": request.user.phone,
        "phone_registered": bool(request.user.phone),
    })


@api_view(["POST"])
def simulate(request):
    """Try a command exactly as if it came from your phone, without sending an SMS. Great for training staff."""
    text = request.data.get("text", "")
    try:
        reply, result = execute(request.user, text, "sms")
    except Exception as exc:  # show business errors as the reply text
        reply, result = f"Not done: {getattr(exc, 'message', str(exc))}", "error"
    return Response({"reply": reply, "result": result})


@api_view(["GET"])
def message_log(request):
    if not request.user.is_admin:
        return Response({"detail": "Admins only."}, status=403)
    rows = MessageLog.objects.select_related("user")[:100]
    return Response([{"id": m.id, "direction": m.direction, "channel": m.channel, "phone": m.phone, "body": m.body,
                      "user": m.user.get_full_name() if m.user else None, "status": m.status, "result": m.result,
                      "created_at": m.created_at} for m in rows])


def _token_ok(request):
    token = request.GET.get("token", "")
    return hmac.compare_digest(token, CFG["INBOUND_TOKEN"])


@csrf_exempt
@require_POST
def inbound_sms(request):
    """Africa's Talking incoming SMS callback: fields from, text, id."""
    if not _token_ok(request):
        return HttpResponse(status=403)
    handle_incoming("sms", request.POST.get("from", ""), request.POST.get("text", ""), request.POST.get("id", ""))
    return HttpResponse("OK")


@csrf_exempt
@require_POST
def inbound_whatsapp(request):
    """Twilio WhatsApp webhook: fields From ('whatsapp:+2547…'), Body, MessageSid."""
    if not _token_ok(request):
        return HttpResponse(status=403)
    handle_incoming("whatsapp", request.POST.get("From", "").replace("whatsapp:", ""), request.POST.get("Body", ""),
                    request.POST.get("MessageSid", ""))
    return HttpResponse("<Response></Response>", content_type="text/xml")
