import re
import secrets

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from .models import Business, normalize_phone

User = get_user_model()

STORE_COLOURS = ["#2563EB", "#7C3AED", "#059669", "#D97706", "#DC2626", "#0891B2", "#DB2777", "#4F46E5"]


def _check_password(password, user=None):
    try:
        validate_password(password, user)
    except DjangoValidationError as exc:
        raise serializers.ValidationError(list(exc.messages))
    return password


def _check_phone(phone, exclude_pk=None):
    phone = normalize_phone(phone)
    if not phone:
        return None
    if not (len(phone) == 12 and phone.startswith("254")):
        raise serializers.ValidationError("Enter a Kenyan mobile number, e.g. 0712 345 678.")
    if User.objects.filter(phone=phone).exclude(pk=exclude_pk).exists():
        raise serializers.ValidationError("This phone number is already registered to another account.")
    return phone


class BusinessSerializer(serializers.ModelSerializer):
    class Meta:
        model = Business
        fields = ["id", "name", "phone", "email", "address", "kra_pin", "created_at"]
        read_only_fields = ["created_at"]


class UserSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, required=False, min_length=8)
    full_name = serializers.SerializerMethodField()
    role_label = serializers.CharField(source="get_role_display", read_only=True)

    class Meta:
        model = User
        fields = ["id", "username", "first_name", "last_name", "full_name", "email", "phone", "role", "role_label",
                  "locations", "sms_alerts", "whatsapp_alerts", "is_active", "password", "last_login", "date_joined"]
        read_only_fields = ["last_login", "date_joined"]

    def get_full_name(self, obj):
        return obj.get_full_name() or obj.username

    def _business_id(self):
        return self.context["request"].user.business_id

    def validate_username(self, value):
        value = value.strip().lower()
        if not re.fullmatch(r"[a-z0-9._@+-]{3,150}", value):
            raise serializers.ValidationError("Use 3 or more letters, numbers, dots or dashes (no spaces).")
        if User.objects.filter(username__iexact=value).exclude(pk=getattr(self.instance, "pk", None)).exists():
            raise serializers.ValidationError("This username is taken. Try another.")
        return value

    def validate_email(self, value):
        value = (value or "").strip().lower()
        if value and User.objects.filter(email__iexact=value).exclude(pk=getattr(self.instance, "pk", None)).exists():
            raise serializers.ValidationError("This email is already used by another account.")
        return value

    def validate_phone(self, value):
        return _check_phone(value, getattr(self.instance, "pk", None))

    def validate_locations(self, value):
        biz = self._business_id()
        if any(l.business_id != biz for l in value):
            raise serializers.ValidationError("Choose stores from your business.")
        return value

    def validate_password(self, value):
        return _check_password(value, self.instance)

    def validate(self, data):
        me = self.context["request"].user
        if self.instance is not None and self.instance.pk == me.pk:
            if data.get("role", me.role) != me.role or data.get("is_active", True) is False:
                raise serializers.ValidationError("You can't change your own role or deactivate yourself.")
        return data

    def create(self, data):
        password = data.pop("password", None)
        locations = data.pop("locations", [])
        user = User(**data, business_id=self._business_id())
        user.set_password(password or secrets.token_urlsafe(12))
        user.save()
        user.locations.set(locations)
        return user

    def update(self, user, data):
        password = data.pop("password", None)
        user = super().update(user, data)
        if password:
            user.set_password(password)
            user.save()
        return user


class MeSerializer(UserSerializer):
    is_admin = serializers.BooleanField(read_only=True)
    business = BusinessSerializer(read_only=True)

    class Meta(UserSerializer.Meta):
        fields = UserSerializer.Meta.fields + ["is_admin", "business"]
        read_only_fields = ["role", "locations", "username", "is_active", "last_login", "date_joined"]

    def validate(self, data):
        return data


class StoreInput(serializers.Serializer):
    name = serializers.CharField(max_length=100)
    kind = serializers.ChoiceField(choices=["shop", "godown"], default="shop")
    address = serializers.CharField(max_length=200, required=False, allow_blank=True, default="")
    latitude = serializers.DecimalField(max_digits=9, decimal_places=6, required=False, allow_null=True)
    longitude = serializers.DecimalField(max_digits=9, decimal_places=6, required=False, allow_null=True)


class RegisterSerializer(serializers.Serializer):
    """Open a new client account: the business, its owner (admin), the main shop and any other shops/godowns."""

    business_name = serializers.CharField(max_length=150)
    full_name = serializers.CharField(max_length=150)
    email = serializers.EmailField()
    phone = serializers.CharField(max_length=20)
    username = serializers.CharField(max_length=150, required=False, allow_blank=True)
    password = serializers.CharField(write_only=True, min_length=8)
    email_code = serializers.RegexField(r"^\s*\d{6}\s*$", write_only=True,
                                        error_messages={"invalid": "Enter the 6-digit code sent to your email."})
    main_shop = StoreInput()
    stores = StoreInput(many=True, required=False)

    def validate_email(self, value):
        value = value.strip().lower()
        if User.objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError("An account with this email already exists. Sign in or reset your password.")
        return value

    def validate_phone(self, value):
        phone = _check_phone(value)
        if not phone:
            raise serializers.ValidationError("Enter your phone number.")
        return phone

    def validate_username(self, value):
        value = (value or "").strip().lower()
        if value:
            if not re.fullmatch(r"[a-z0-9._@+-]{3,150}", value):
                raise serializers.ValidationError("Use 3 or more letters, numbers, dots or dashes (no spaces).")
            if User.objects.filter(username__iexact=value).exists():
                raise serializers.ValidationError("This username is taken. Try another.")
        return value

    def validate_password(self, value):
        return _check_password(value)

    def validate(self, data):
        from .models import SignupCode

        entry = SignupCode.latest(data["email"])
        if not entry or not entry.matches(data["email_code"]):
            raise serializers.ValidationError({"email_code": "That code is wrong or has expired. Ask for a new one."})
        data["_code_entry"] = entry
        stores = [data["main_shop"]] + list(data.get("stores") or [])
        names = [s["name"].strip().lower() for s in stores]
        if len(set(names)) != len(names):
            raise serializers.ValidationError("Give each shop and godown a different name.")
        if len(stores) > 50:
            raise serializers.ValidationError("You can add more stores later from the app.")
        return data

    @transaction.atomic
    def create(self, data):
        from inventory.models import Location
        from inventory.serializers import suggest_code

        entry = data.pop("_code_entry")
        data.pop("email_code", None)
        entry.used = True
        entry.save(update_fields=["used"])

        business = Business.objects.create(name=data["business_name"].strip(), email=data["email"], phone=data["phone"],
                                           address=data["main_shop"].get("address", ""))
        first, _, last = data["full_name"].strip().partition(" ")
        username = data.get("username") or data["email"]
        if User.objects.filter(username__iexact=username).exists():
            username = f"{data['email'].split('@')[0]}{secrets.randbelow(900) + 100}"
        user = User(username=username, email=data["email"], phone=data["phone"], first_name=first[:150],
                    last_name=last[:150], role=User.Role.ADMIN, business=business)
        user.set_password(data["password"])
        user.save()
        taken = []
        for i, store in enumerate([data["main_shop"]] + list(data.get("stores") or [])):
            main = i == 0
            kind = "shop" if main else store.get("kind", "shop")
            code = suggest_code(store["name"], taken)
            taken.append(code)
            Location.objects.create(
                business=business, code=code, name=store["name"].strip(), kind=kind, is_main=main,
                address=store.get("address", ""), latitude=store.get("latitude"), longitude=store.get("longitude"),
                can_sell=kind == "shop", color=STORE_COLOURS[i % len(STORE_COLOURS)])
        return user


class LoginSerializer(TokenObtainPairSerializer):
    """Sign in with username OR email."""

    def validate(self, attrs):
        login = (attrs.get(self.username_field) or "").strip()
        if "@" in login:
            match = User.objects.filter(email__iexact=login).only("username").first()
            if match:
                login = match.username
        else:
            match = User.objects.filter(username__iexact=login).only("username").first()
            if match:
                login = match.username
        attrs[self.username_field] = login
        return super().validate(attrs)


class ForgotPasswordSerializer(serializers.Serializer):
    email = serializers.CharField(max_length=254)


class ResetPasswordSerializer(serializers.Serializer):
    email = serializers.CharField(max_length=254)
    code = serializers.RegexField(r"^\s*\d{6}\s*$", error_messages={"invalid": "The code has 6 digits."})
    new_password = serializers.CharField(min_length=8, required=False)
