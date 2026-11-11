"""
M-Pesa payments through Safaricom Daraja: STK push (the "enter your M-Pesa PIN" prompt on the customer's phone).

Backends (MPESA_BACKEND in .env):
  console  development: no money moves; the prompt is marked paid straight away with a fake receipt number
  daraja   real Safaricom API (sandbox or production, MPESA_ENV)

Flow: the till calls start_stk_push() → Safaricom shows the prompt → the customer enters their PIN →
Safaricom calls our callback (handle_callback) → the payment becomes SUCCESS / FAILED / CANCELLED.
If the callback can't reach us (e.g. developing on a laptop), refresh_status() asks Safaricom directly.
"""
import base64
import logging
import secrets
import string
from datetime import timedelta
from decimal import Decimal

import requests
from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

from accounts.models import normalize_phone

from .exceptions import StockError
from .models import MpesaPayment

log = logging.getLogger(__name__)
CFG = settings.MPESA


def is_live():
    return CFG["BACKEND"] == "daraja"


def _base():
    return "https://api.safaricom.co.ke" if CFG["ENV"] == "production" else "https://sandbox.safaricom.co.ke"


def _token():
    key = f"mpesa-token-{CFG['ENV']}"
    token = cache.get(key)
    if token:
        return token
    r = requests.get(f"{_base()}/oauth/v1/generate?grant_type=client_credentials",
                     auth=(CFG["CONSUMER_KEY"], CFG["CONSUMER_SECRET"]), timeout=20)
    r.raise_for_status()
    data = r.json()
    token = data["access_token"]
    cache.set(key, token, int(data.get("expires_in", 3599)) - 60)
    return token


def _password(timestamp):
    raw = f"{CFG['SHORTCODE']}{CFG['PASSKEY']}{timestamp}"
    return base64.b64encode(raw.encode()).decode()


def _timestamp():
    return timezone.localtime().strftime("%Y%m%d%H%M%S")


def _fake_receipt():
    return "SIM" + "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(7))


def start_stk_push(*, business, location, user, phone, amount, reference, callback_url) -> MpesaPayment:
    phone = normalize_phone(phone)
    if not (len(phone) == 12 and phone.startswith("254") and phone[3] in "17"):
        raise StockError("Enter the customer's Safaricom number, e.g. 0712 345 678.", "bad_phone")
    amount = Decimal(str(amount)).quantize(Decimal("1"))
    if amount < 1:
        raise StockError("The amount must be at least KES 1.", "bad_amount")
    payment = MpesaPayment.objects.create(business=business, location=location, created_by=user, phone=phone,
                                          amount=amount, account_reference=(reference or "StockFlow")[:12])
    if not is_live():
        payment.checkout_request_id = f"ws_CO_SIM_{payment.pk}_{secrets.token_hex(4)}"
        payment.status = MpesaPayment.Status.SUCCESS
        payment.result_code, payment.result_desc = "0", "Simulated payment (MPESA_BACKEND=console)"
        payment.receipt_number = _fake_receipt()
        payment.save()
        log.info("[M-PESA console] KES %s from %s marked paid as %s", amount, phone, payment.receipt_number)
        return payment

    if not all(CFG[k] for k in ("CONSUMER_KEY", "CONSUMER_SECRET", "SHORTCODE", "PASSKEY")):
        payment.status, payment.result_desc = MpesaPayment.Status.FAILED, "M-Pesa is not configured on the server"
        payment.save()
        raise StockError("M-Pesa prompts are not set up yet. Type the M-Pesa code instead.", "mpesa_not_configured")
    ts = _timestamp()
    body = {
        "BusinessShortCode": CFG["SHORTCODE"],
        "Password": _password(ts),
        "Timestamp": ts,
        "TransactionType": CFG["TRANSACTION_TYPE"],
        "Amount": int(amount),
        "PartyA": phone,
        "PartyB": CFG["PARTY_B"] or CFG["SHORTCODE"],
        "PhoneNumber": phone,
        "CallBackURL": CFG["CALLBACK_URL"] or callback_url,
        "AccountReference": payment.account_reference,
        "TransactionDesc": f"Payment {payment.account_reference}"[:13],
    }
    try:
        r = requests.post(f"{_base()}/mpesa/stkpush/v1/processrequest", json=body, timeout=30,
                          headers={"Authorization": f"Bearer {_token()}"})
        data = r.json() if r.content else {}
    except (requests.RequestException, ValueError) as exc:
        log.exception("STK push failed")
        payment.status, payment.result_desc = MpesaPayment.Status.FAILED, f"Network error: {exc.__class__.__name__}"
        payment.save()
        raise StockError("Couldn't reach M-Pesa. Check the connection or type the M-Pesa code instead.", "mpesa_down")
    if str(data.get("ResponseCode")) != "0":
        payment.status = MpesaPayment.Status.FAILED
        payment.result_desc = (data.get("errorMessage") or data.get("ResponseDescription") or "Rejected by M-Pesa")[:255]
        payment.save()
        raise StockError(f"M-Pesa refused the request: {payment.result_desc}", "mpesa_rejected")
    payment.merchant_request_id = data.get("MerchantRequestID", "")
    payment.checkout_request_id = data.get("CheckoutRequestID")
    payment.result_desc = data.get("CustomerMessage", "")[:255]
    payment.save()
    return payment


def _apply_result(payment, code, desc, metadata=None):
    code = str(code)
    payment.result_code, payment.result_desc = code, (desc or "")[:255]
    if code == "0":
        items = {i.get("Name"): i.get("Value") for i in (metadata or {}).get("Item", [])}
        payment.status = MpesaPayment.Status.SUCCESS
        payment.receipt_number = str(items.get("MpesaReceiptNumber") or payment.receipt_number or "")[:20]
        if items.get("Amount") is not None:
            payment.amount = Decimal(str(items["Amount"]))
    elif code in ("1032", "1031", "1037"):  # cancelled by user / no response from the phone
        payment.status = MpesaPayment.Status.CANCELLED
    else:
        payment.status = MpesaPayment.Status.FAILED
    payment.save()
    return payment


def handle_callback(data):
    cb = (data or {}).get("Body", {}).get("stkCallback", {})
    checkout = cb.get("CheckoutRequestID")
    payment = MpesaPayment.objects.filter(checkout_request_id=checkout).first() if checkout else None
    if not payment:
        log.warning("M-Pesa callback for unknown request %s", checkout)
        return None
    if payment.status != MpesaPayment.Status.PENDING:
        return payment  # Safaricom may retry; first result wins
    return _apply_result(payment, cb.get("ResultCode"), cb.get("ResultDesc"), cb.get("CallbackMetadata"))


def refresh_status(payment: MpesaPayment) -> MpesaPayment:
    """Ask Safaricom directly when the callback hasn't arrived (at most every 5 seconds)."""
    if payment.status != MpesaPayment.Status.PENDING or not is_live() or not payment.checkout_request_id:
        return payment
    if timezone.now() - payment.updated_at < timedelta(seconds=5):
        return payment
    ts = _timestamp()
    try:
        r = requests.post(f"{_base()}/mpesa/stkpushquery/v1/query", timeout=20,
                          headers={"Authorization": f"Bearer {_token()}"},
                          json={"BusinessShortCode": CFG["SHORTCODE"], "Password": _password(ts), "Timestamp": ts,
                                "CheckoutRequestID": payment.checkout_request_id})
        data = r.json() if r.content else {}
    except (requests.RequestException, ValueError):
        payment.save(update_fields=["updated_at"])
        return payment
    code = data.get("ResultCode")
    if code is None:  # "still processing"
        payment.save(update_fields=["updated_at"])
        if timezone.now() - payment.created_at > timedelta(minutes=3):
            return _apply_result(payment, "1037", "No answer from the customer's phone")
        return payment
    payment = _apply_result(payment, code, data.get("ResultDesc"))
    if payment.status == MpesaPayment.Status.SUCCESS and not payment.receipt_number:
        # The query API doesn't return the receipt number; the callback will fill it in if it arrives.
        payment.receipt_number = f"CHK{payment.pk:07d}"[:20]
        payment.save(update_fields=["receipt_number"])
    return payment
