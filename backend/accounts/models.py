from django.contrib.auth.models import AbstractUser
from django.db import models


def normalize_phone(phone: str) -> str:
    """Store every phone as 2547XXXXXXXX so SMS/WhatsApp senders can be matched reliably."""
    digits = "".join(ch for ch in (phone or "") if ch.isdigit())
    if digits.startswith("0") and len(digits) == 10:
        digits = "254" + digits[1:]
    elif len(digits) == 9 and digits[0] in "17":
        digits = "254" + digits
    return digits


class User(AbstractUser):
    class Role(models.TextChoices):
        ADMIN = "admin", "Admin (owner)"
        MANAGER = "manager", "Stock manager"
        STAFF = "staff", "Shop staff"

    role = models.CharField(max_length=10, choices=Role.choices, default=Role.STAFF)
    phone = models.CharField(max_length=15, unique=True, null=True, blank=True,
                             help_text="Used to recognise SMS/WhatsApp commands. Any format, e.g. 0712345678.")
    locations = models.ManyToManyField("inventory.Location", blank=True, related_name="staff",
                                       help_text="Stores this person works in. Admins see everything.")
    sms_alerts = models.BooleanField(default=False, help_text="Also send important alerts by SMS")
    whatsapp_alerts = models.BooleanField(default=False)

    def save(self, *args, **kwargs):
        if self.phone:
            self.phone = normalize_phone(self.phone)
        else:
            self.phone = None
        if self.is_superuser:
            self.role = self.Role.ADMIN
        super().save(*args, **kwargs)

    @property
    def is_admin(self):
        return self.role == self.Role.ADMIN or self.is_superuser

    def can_access(self, location) -> bool:
        if self.is_admin:
            return True
        loc_id = getattr(location, "pk", location)
        return self.locations.filter(pk=loc_id).exists()

    def can_manage(self, location) -> bool:
        return self.is_admin or (self.role == self.Role.MANAGER and self.can_access(location))

    def accessible_location_ids(self):
        from inventory.models import Location

        qs = Location.objects.all() if self.is_admin else self.locations.all()
        return list(qs.values_list("id", flat=True))
