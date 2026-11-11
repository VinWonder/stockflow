import logging

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.mail import send_mail
from django.db.models import Q
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView

from .models import PasswordResetCode
from .serializers import (BusinessSerializer, ForgotPasswordSerializer, LoginSerializer, MeSerializer,
                          RegisterSerializer, ResetPasswordSerializer, UserSerializer)

User = get_user_model()
log = logging.getLogger(__name__)


class IsAdminRole(permissions.BasePermission):
    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.is_admin)


class AuthThrottle(AnonRateThrottle):
    scope = "auth"
    rate = "10/min"


class UserViewSet(viewsets.ModelViewSet):
    """The owner's team: managers and shop staff, with the stores each one works in."""

    serializer_class = UserSerializer
    permission_classes = [IsAdminRole]
    search_fields = ["username", "first_name", "last_name", "phone", "email"]
    filterset_fields = ["role", "is_active"]
    pagination_class = None

    def get_queryset(self):
        return (User.objects.filter(business_id=self.request.user.business_id)
                .prefetch_related("locations").order_by("-is_active", "role", "first_name", "username"))

    def perform_destroy(self, user):
        if user.pk == self.request.user.pk:
            raise ValidationError("You can't remove your own account.")
        user.is_active = False  # keep their name on past documents
        user.save(update_fields=["is_active"])


class LoginView(TokenObtainPairView):
    serializer_class = LoginSerializer
    throttle_classes = [AuthThrottle]


def _tokens(user):
    refresh = RefreshToken.for_user(user)
    return {"access": str(refresh.access_token), "refresh": str(refresh)}


def _send_code(email, subject, intro, code, minutes):
    send_mail(
        subject=subject,
        message=f"{intro}\n\n    {code}\n\nIt works for {minutes} minutes. If you didn't ask for this, ignore this email.\n\nStockFlow",
        from_email=settings.DEFAULT_FROM_EMAIL,
        recipient_list=[email],
    )


@api_view(["POST"])
@permission_classes([permissions.AllowAny])
@throttle_classes([AuthThrottle])
def signup_code(request):
    """Step 1 of opening an account: email a 6-digit code to prove the email belongs to the owner."""
    from .models import SignupCode

    email = (request.data.get("email") or "").strip().lower()
    if "@" not in email or "." not in email.split("@")[-1]:
        raise ValidationError({"email": "Enter a valid email address."})
    if User.objects.filter(email__iexact=email).exists():
        raise ValidationError({"email": "An account with this email already exists. Sign in or reset your password."})
    code = SignupCode.issue(email)
    try:
        _send_code(email, f"Your StockFlow code: {code}", "Welcome to StockFlow. Your code to confirm your email is:",
                   code, int(SignupCode.LIFETIME.total_seconds() // 60))
    except Exception:  # noqa: BLE001
        log.exception("Sending the sign-up code failed")
        return Response({"detail": "We couldn't send the email right now. Check the address or try again in a minute."},
                        status=503)
    entry = SignupCode.latest(email)
    return Response({
        "detail": f"A 6-digit code was sent to {email}.",
        "expires_at": (entry.created_at + SignupCode.LIFETIME).isoformat(),
    })


@api_view(["POST"])
@permission_classes([permissions.AllowAny])
@throttle_classes([AuthThrottle])
def signup_verify(request):
    """Check the emailed code before the owner fills in the stores (the code is used up when the account is created)."""
    from .models import SignupCode

    entry = SignupCode.latest(request.data.get("email"))
    if not entry or not entry.matches(request.data.get("code")):
        raise ValidationError({"code": "That code is wrong or has expired. Ask for a new one."})
    return Response({"ok": True})


@api_view(["POST"])
@permission_classes([permissions.AllowAny])
@throttle_classes([AuthThrottle])
def register(request):
    """Create a client account (email already confirmed with a code). The owner then signs in."""
    s = RegisterSerializer(data=request.data)
    s.is_valid(raise_exception=True)
    user = s.save()
    return Response({"detail": "Account created. Sign in to continue.", "username": user.username, "email": user.email},
                    status=status.HTTP_201_CREATED)


@api_view(["GET", "PATCH"])
def me(request):
    if request.method == "PATCH":
        s = MeSerializer(request.user, data=request.data, partial=True, context={"request": request})
        s.is_valid(raise_exception=True)
        s.save()
    return Response(MeSerializer(request.user).data)


@api_view(["GET", "PATCH"])
def business(request):
    biz = request.user.business
    if biz is None:
        return Response({"detail": "This account isn't linked to a business."}, status=404)
    if request.method == "PATCH":
        if not request.user.is_admin:
            return Response({"detail": "Only the owner can change business details."}, status=403)
        s = BusinessSerializer(biz, data=request.data, partial=True)
        s.is_valid(raise_exception=True)
        s.save()
    return Response(BusinessSerializer(biz).data)


@api_view(["POST"])
def change_password(request):
    old, new = request.data.get("old_password", ""), request.data.get("new_password", "")
    if not request.user.check_password(old):
        raise ValidationError({"old_password": "That isn't your current password."})
    from .serializers import _check_password

    _check_password(new, request.user)
    request.user.set_password(new)
    request.user.save()
    return Response(_tokens(request.user))


def _find_user(login):
    login = (login or "").strip()
    if not login:
        return None
    return User.objects.filter(Q(email__iexact=login) | Q(username__iexact=login), is_active=True).first()


@api_view(["POST"])
@permission_classes([permissions.AllowAny])
@throttle_classes([AuthThrottle])
def forgot_password(request):
    """Email a 6-digit code. The answer is the same whether or not the account exists (no account fishing)."""
    s = ForgotPasswordSerializer(data=request.data)
    s.is_valid(raise_exception=True)
    user = _find_user(s.validated_data["email"])
    if user and user.email:
        code = PasswordResetCode.issue(user)
        name = user.first_name or user.username
        try:
            _send_code(user.email, f"Your StockFlow reset code: {code}",
                       f"Hi {name},\n\nYour StockFlow password reset code is:", code,
                       int(PasswordResetCode.LIFETIME.total_seconds() // 60))
        except Exception:  # noqa: BLE001 - SMTP errors must not reveal whether the account exists
            log.exception("Sending the reset email to user %s failed", user.pk)
            return Response({"detail": "We couldn't send the email right now. Try again in a minute."}, status=503)
    return Response({"detail": "If that account exists, a 6-digit code has been sent to its email."})


def _valid_code(data):
    s = ResetPasswordSerializer(data=data)
    s.is_valid(raise_exception=True)
    user = _find_user(s.validated_data["email"])
    entry = PasswordResetCode.objects.filter(user=user, used=False).first() if user else None
    if not entry or not entry.matches(s.validated_data["code"]):
        raise ValidationError({"code": "That code is wrong or has expired. Ask for a new one."})
    return user, entry, s.validated_data.get("new_password")


@api_view(["POST"])
@permission_classes([permissions.AllowAny])
@throttle_classes([AuthThrottle])
def verify_reset_code(request):
    _valid_code(request.data)
    return Response({"ok": True})


@api_view(["POST"])
@permission_classes([permissions.AllowAny])
@throttle_classes([AuthThrottle])
def reset_password(request):
    user, entry, new_password = _valid_code(request.data)
    if not new_password:
        raise ValidationError({"new_password": "Choose a new password (at least 8 characters)."})
    from .serializers import _check_password

    _check_password(new_password, user)
    user.set_password(new_password)
    user.save()
    entry.used = True
    entry.save(update_fields=["used"])
    return Response({"detail": "Password changed. Sign in with your new password.", "username": user.username})
