"""Send email through Brevo's HTTPS API.

Render's free plan blocks outgoing SMTP (ports 25/465/587), so Gmail SMTP can't be used there.
Brevo's API runs over normal HTTPS (port 443) and has a free tier of 300 emails a day.
Set BREVO_API_KEY and make sure the sender address is a verified sender in Brevo.
"""
import json
import logging
import urllib.error
import urllib.request
from email.utils import parseaddr

from django.conf import settings
from django.core.mail.backends.base import BaseEmailBackend

log = logging.getLogger(__name__)
API_URL = "https://api.brevo.com/v3/smtp/email"


class BrevoEmailBackend(BaseEmailBackend):
    def send_messages(self, email_messages):
        sent = 0
        for message in email_messages:
            try:
                self._send(message)
                sent += 1
            except Exception:
                if not self.fail_silently:
                    raise
                log.exception("Brevo email failed")
        return sent

    def _send(self, message):
        name, address = parseaddr(message.from_email or settings.DEFAULT_FROM_EMAIL)
        payload = {
            "sender": {"email": address, **({"name": name} if name else {})},
            "to": [{"email": parseaddr(r)[1]} for r in message.recipients()],
            "subject": message.subject,
            "textContent": message.body,
        }
        for content, mimetype in getattr(message, "alternatives", []):
            if mimetype == "text/html":
                payload["htmlContent"] = content
        request = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode(),
            headers={"api-key": settings.BREVO_API_KEY, "content-type": "application/json", "accept": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=settings.EMAIL_TIMEOUT) as response:
                response.read()
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Brevo refused the email ({e.code}): {e.read().decode(errors='replace')[:300]}") from e
