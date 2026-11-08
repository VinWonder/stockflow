from django.conf import settings
from django.db import models


class Notification(models.Model):
    class Kind(models.TextChoices):
        TRANSFER = "transfer", "Transfer"
        REQUEST = "request", "Stock request"
        LOW_STOCK = "low_stock", "Low stock"
        RECEIPT = "receipt", "Delivery"
        COUNT = "count", "Stocktake"
        SYSTEM = "system", "System"

    user = models.ForeignKey(settings.AUTH_USER_MODEL, related_name="notifications", on_delete=models.CASCADE)
    kind = models.CharField(max_length=12, choices=Kind.choices)
    title = models.CharField(max_length=120)
    body = models.CharField(max_length=500)
    ref_type = models.CharField(max_length=20, blank=True, help_text="transfer | request | receipt | count | level")
    ref_id = models.PositiveBigIntegerField(null=True, blank=True)
    needs_action = models.BooleanField(default=False, help_text="Shows an action button in the app")
    is_read = models.BooleanField(default=False, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "is_read", "-created_at"])]

    def __str__(self):
        return f"{self.user}: {self.title}"


class MessageLog(models.Model):
    """Every SMS / WhatsApp sent or received, for audit and debugging."""

    class Direction(models.TextChoices):
        IN = "in", "Incoming"
        OUT = "out", "Outgoing"

    class Channel(models.TextChoices):
        SMS = "sms", "SMS"
        WHATSAPP = "whatsapp", "WhatsApp"

    direction = models.CharField(max_length=3, choices=Direction.choices)
    channel = models.CharField(max_length=10, choices=Channel.choices)
    phone = models.CharField(max_length=20, db_index=True)
    body = models.TextField()
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL)
    status = models.CharField(max_length=20, default="ok")
    result = models.CharField(max_length=255, blank=True, help_text="What the system did, e.g. created SR00012")
    provider_id = models.CharField(max_length=100, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.direction} {self.channel} {self.phone}"
