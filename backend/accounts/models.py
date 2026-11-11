import secrets
from datetime import timedelta

from django.contrib.auth.hashers import check_password, make_password
from django.contrib.auth.models import AbstractUser
from django.db import models
from django.utils import timezone


def normalize_phone(phone: str) -> str:
    """Store every phone as 2547XXXXXXXX so SMS/WhatsApp senders can be matched reliably."""
    digits = "".join(ch for ch in (phone or "") if ch.isdigit())
    if digits.startswith("0") and len(digits) == 10:
        digits = "254" + digits[1:]
    elif len(digits) == 9 and digits[0] in "17":
        digits = "254" + digits
    return digits


class Business(models.Model):
    """One client account: the owner's company with its main shop, other shops and godowns.

    Every store, product, supplier and customer belongs to exactly one business, and users only
    ever see their own business's data.
    """

    name = models.CharField(max_length=150)
    phone = models.CharField(max_length=20, blank=True)
    email = models.EmailField(blank=True)
    address = models.CharField(max_length=200, blank=True)
    kra_pin = models.CharField("KRA PIN", max_length=20, blank=True)
    mpesa_shortcode = models.CharField(
        "M-Pesa paybill / till store number", max_length=12, blank=True, db_index=True,
        help_text="Payments Safaricom reports for this number are used to confirm M-Pesa codes typed at the till")
    mpesa_connected_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name_plural = "businesses"
        ordering = ["name"]

    def __str__(self):
        return self.name


class User(AbstractUser):
    class Role(models.TextChoices):
        ADMIN = "admin", "Admin (owner)"
        MANAGER = "manager", "Stock manager"
        STAFF = "staff", "Shop staff"

    business = models.ForeignKey(Business, null=True, blank=True, on_delete=models.CASCADE, related_name="users")
    role = models.CharField(max_length=10, choices=Role.choices, default=Role.STAFF)
    phone = models.CharField(max_length=15, unique=True, null=True, blank=True,
                             help_text="Used to recognise SMS/WhatsApp commands. Any format, e.g. 0712345678.")
    locations = models.ManyToManyField("inventory.Location", blank=True, related_name="staff",
                                       help_text="Stores this person works in. Admins see everything in their business.")
    sms_alerts = models.BooleanField(default=False, help_text="Also send important alerts by SMS")
    whatsapp_alerts = models.BooleanField(default=False)

    def save(self, *args, **kwargs):
        if self.phone:
            self.phone = normalize_phone(self.phone)
        else:
            self.phone = None
        self.email = (self.email or "").strip().lower()
        if self.is_superuser:
            self.role = self.Role.ADMIN
        super().save(*args, **kwargs)

    @property
    def is_admin(self):
        return self.role == self.Role.ADMIN or self.is_superuser

    def business_locations(self):
        from inventory.models import Location

        return Location.objects.filter(business_id=self.business_id)

    def can_access(self, location) -> bool:
        loc_id = getattr(location, "pk", location)
        if self.is_admin:
            return self.business_locations().filter(pk=loc_id).exists()
        return self.locations.filter(pk=loc_id, business_id=self.business_id).exists()

    def can_manage(self, location) -> bool:
        return self.can_access(location) and (self.is_admin or self.role == self.Role.MANAGER)

    def accessible_location_ids(self):
        qs = self.business_locations() if self.is_admin else self.locations.filter(business_id=self.business_id)
        return list(qs.values_list("id", flat=True))


class PasswordResetCode(models.Model):
    """A 6-digit code emailed to the user. Only a hash is stored; it expires and allows few attempts."""

    LIFETIME = timedelta(minutes=15)
    MAX_ATTEMPTS = 5

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="reset_codes")
    code_hash = models.CharField(max_length=128)
    attempts = models.PositiveSmallIntegerField(default=0)
    used = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    @classmethod
    def issue(cls, user):
        cls.objects.filter(user=user, used=False).update(used=True)  # only the newest code works
        code = f"{secrets.randbelow(1_000_000):06d}"
        cls.objects.create(user=user, code_hash=make_password(code))
        return code

    @property
    def expired(self):
        return timezone.now() - self.created_at > self.LIFETIME

    def matches(self, code) -> bool:
        if self.used or self.expired or self.attempts >= self.MAX_ATTEMPTS:
            return False
        if check_password((code or "").strip(), self.code_hash):
            return True
        self.attempts += 1
        self.save(update_fields=["attempts"])
        return False


class SignupCode(models.Model):
    """6-digit code emailed to confirm the owner's email before the account is created."""

    LIFETIME = timedelta(minutes=15)
    MAX_ATTEMPTS = 5

    email = models.EmailField(db_index=True)
    code_hash = models.CharField(max_length=128)
    attempts = models.PositiveSmallIntegerField(default=0)
    used = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    @classmethod
    def issue(cls, email):
        email = email.strip().lower()
        cls.objects.filter(email=email, used=False).update(used=True)
        code = f"{secrets.randbelow(1_000_000):06d}"
        cls.objects.create(email=email, code_hash=make_password(code))
        return code

    @classmethod
    def latest(cls, email):
        return cls.objects.filter(email=(email or "").strip().lower(), used=False).first()

    @property
    def expired(self):
        return timezone.now() - self.created_at > self.LIFETIME

    def matches(self, code) -> bool:
        if self.used or self.expired or self.attempts >= self.MAX_ATTEMPTS:
            return False
        if check_password((code or "").strip(), self.code_hash):
            return True
        self.attempts += 1
        self.save(update_fields=["attempts"])
        return False
