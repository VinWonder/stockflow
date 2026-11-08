"""Outbound SMS / WhatsApp. Backends: console (development), africastalking (SMS), twilio (WhatsApp)."""
import logging

import requests
from django.conf import settings

from .models import MessageLog

log = logging.getLogger(__name__)
CFG = settings.MESSAGING


def _intl(phone):
    digits = "".join(c for c in phone if c.isdigit())
    return f"+{digits}"


def send(channel, phone, body, user=None):
    if not phone:
        return None
    backend = CFG["SMS_BACKEND"] if channel == "sms" else CFG["WHATSAPP_BACKEND"]
    status, provider_id = "sent", ""
    try:
        if backend == "africastalking" and channel == "sms":
            base = "https://api.sandbox.africastalking.com" if CFG["AT_USERNAME"] == "sandbox" else "https://api.africastalking.com"
            data = {"username": CFG["AT_USERNAME"], "to": _intl(phone), "message": body}
            if CFG["AT_SENDER_ID"]:
                data["from"] = CFG["AT_SENDER_ID"]
            r = requests.post(f"{base}/version1/messaging", data=data, timeout=20,
                              headers={"apiKey": CFG["AT_API_KEY"], "Accept": "application/json"})
            r.raise_for_status()
            recipients = r.json().get("SMSMessageData", {}).get("Recipients", [])
            provider_id = recipients[0].get("messageId", "") if recipients else ""
        elif backend == "twilio":
            sid, token = CFG["TWILIO_ACCOUNT_SID"], CFG["TWILIO_AUTH_TOKEN"]
            prefix = "whatsapp:" if channel == "whatsapp" else ""
            r = requests.post(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json", auth=(sid, token), timeout=20,
                              data={"From": CFG["TWILIO_WHATSAPP_FROM"] if channel == "whatsapp" else CFG["BUSINESS_SMS_NUMBER"],
                                    "To": f"{prefix}{_intl(phone)}", "Body": body})
            r.raise_for_status()
            provider_id = r.json().get("sid", "")
        else:
            log.info("[%s → %s]\n%s", channel.upper(), phone, body)
            status = "console"
    except requests.RequestException as exc:
        log.exception("Sending %s to %s failed", channel, phone)
        status = f"failed: {exc.__class__.__name__}"
    return MessageLog.objects.create(direction="out", channel=channel, phone=phone, body=body[:1600], user=user,
                                     status=status[:20], provider_id=provider_id)
