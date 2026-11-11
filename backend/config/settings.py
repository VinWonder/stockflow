"""StockFlow backend settings. Secrets come from .env (see .env.example)."""
from datetime import timedelta
from pathlib import Path

import environ

BASE_DIR = Path(__file__).resolve().parent.parent
env = environ.Env(DEBUG=(bool, False))
environ.Env.read_env(BASE_DIR / ".env")

SECRET_KEY = env("SECRET_KEY", default="dev-only-insecure-key")
DEBUG = env("DEBUG")
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=["localhost", "127.0.0.1", "10.0.2.2"])
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])

# Render gives each service its own https://<name>.onrender.com address.
RENDER_EXTERNAL_HOSTNAME = env("RENDER_EXTERNAL_HOSTNAME", default="")
if RENDER_EXTERNAL_HOSTNAME:
    ALLOWED_HOSTS.append(RENDER_EXTERNAL_HOSTNAME)
    CSRF_TRUSTED_ORIGINS.append(f"https://{RENDER_EXTERNAL_HOSTNAME}")

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "rest_framework_simplejwt",
    "django_filters",
    "corsheaders",
    "accounts",
    "inventory",
    "messaging",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
TEMPLATES = [{
    "BACKEND": "django.template.backends.django.DjangoTemplates",
    "DIRS": [],
    "APP_DIRS": True,
    "OPTIONS": {"context_processors": [
        "django.template.context_processors.request",
        "django.contrib.auth.context_processors.auth",
        "django.contrib.messages.context_processors.messages",
    ]},
}]
WSGI_APPLICATION = "config.wsgi.application"

DATABASES = {"default": env.db("DATABASE_URL", default=f"sqlite:///{BASE_DIR / 'db.sqlite3'}")}
DATABASES["default"]["CONN_MAX_AGE"] = 60

AUTH_USER_MODEL = "accounts.User"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 8}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
]

LANGUAGE_CODE = "en-gb"
TIME_ZONE = env("TIME_ZONE", default="Africa/Nairobi")
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

# The installable web app (`npm run build` in ../web) is served at / so the app and API share one address.
FRONTEND_DIR = Path(env("FRONTEND_DIR", default=str(BASE_DIR.parent / "web" / "dist")))
WHITENOISE_ROOT = FRONTEND_DIR if FRONTEND_DIR.exists() else None
WHITENOISE_MIMETYPES = {".webmanifest": "application/manifest+json"}

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework_simplejwt.authentication.JWTAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_FILTER_BACKENDS": [
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.SearchFilter",
        "rest_framework.filters.OrderingFilter",
    ],
    "DEFAULT_PAGINATION_CLASS": "inventory.pagination.Pagination",
    "PAGE_SIZE": 30,
    "EXCEPTION_HANDLER": "inventory.exceptions.api_exception_handler",
    "DEFAULT_THROTTLE_RATES": {"anon": "60/min", "auth": "10/min"},
}
SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(hours=8),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=30),
    "ROTATE_REFRESH_TOKENS": True,
}

CORS_ALLOWED_ORIGINS = env.list("CORS_ALLOWED_ORIGINS", default=[])
CORS_ALLOW_ALL_ORIGINS = DEBUG  # only needed if the web app is hosted on a different address

# Business messaging -----------------------------------------------------------
MESSAGING = {
    # console | africastalking | twilio
    "SMS_BACKEND": env("SMS_BACKEND", default="console"),
    "WHATSAPP_BACKEND": env("WHATSAPP_BACKEND", default="console"),
    "BUSINESS_SMS_NUMBER": env("BUSINESS_SMS_NUMBER", default=""),
    "BUSINESS_WHATSAPP_NUMBER": env("BUSINESS_WHATSAPP_NUMBER", default=""),
    "INBOUND_TOKEN": env("INBOUND_TOKEN", default="change-me"),
    "AT_USERNAME": env("AT_USERNAME", default="sandbox"),
    "AT_API_KEY": env("AT_API_KEY", default=""),
    "AT_SENDER_ID": env("AT_SENDER_ID", default=""),
    "TWILIO_ACCOUNT_SID": env("TWILIO_ACCOUNT_SID", default=""),
    "TWILIO_AUTH_TOKEN": env("TWILIO_AUTH_TOKEN", default=""),
    "TWILIO_WHATSAPP_FROM": env("TWILIO_WHATSAPP_FROM", default=""),
}
CURRENCY = env("CURRENCY", default="KES")

# Public address of the app, used in links sent by SMS (e.g. the driver's tracking link).
# Leave empty to use the address the request came in on.
PUBLIC_APP_URL = env("PUBLIC_APP_URL", default=RENDER_EXTERNAL_HOSTNAME and f"https://{RENDER_EXTERNAL_HOSTNAME}").rstrip("/")

# Email (forgot-password codes) ------------------------------------------------
# Gmail: turn on 2-Step Verification, create an App Password (Google Account → Security → App passwords)
# and put it in EMAIL_HOST_PASSWORD. Without a password, emails are printed in the terminal instead.
EMAIL_HOST = env("EMAIL_HOST", default="smtp.gmail.com")
EMAIL_PORT = env.int("EMAIL_PORT", default=587)
EMAIL_USE_TLS = env.bool("EMAIL_USE_TLS", default=True)
EMAIL_HOST_USER = env("EMAIL_HOST_USER", default="")
EMAIL_HOST_PASSWORD = env("EMAIL_HOST_PASSWORD", default="")
EMAIL_TIMEOUT = 20
# Ask new owners for an emailed code at sign-up. Off until email sending works on the live server.
SIGNUP_EMAIL_CODE = env.bool("SIGNUP_EMAIL_CODE", default=False)
# Render's free plan blocks SMTP, so on Render use Brevo's HTTPS API (BREVO_API_KEY) instead of Gmail SMTP.
BREVO_API_KEY = env("BREVO_API_KEY", default="")
EMAIL_BACKEND = env("EMAIL_BACKEND", default=(
    "accounts.email_backend.BrevoEmailBackend" if BREVO_API_KEY
    else "django.core.mail.backends.smtp.EmailBackend" if EMAIL_HOST_PASSWORD
    else "django.core.mail.backends.console.EmailBackend"))
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", default=f"StockFlow <{EMAIL_HOST_USER or 'no-reply@stockflow.local'}>")

# M-Pesa (Safaricom Daraja STK push) ---------------------------------------------
MPESA = {
    "BACKEND": env("MPESA_BACKEND", default="console"),  # console (pretend, for testing) | daraja (real)
    "ENV": env("MPESA_ENV", default="sandbox"),  # sandbox | production
    "CONSUMER_KEY": env("MPESA_CONSUMER_KEY", default=""),
    "CONSUMER_SECRET": env("MPESA_CONSUMER_SECRET", default=""),
    "SHORTCODE": env("MPESA_SHORTCODE", default="174379"),  # paybill / store number (174379 = Daraja sandbox)
    "PASSKEY": env("MPESA_PASSKEY", default=""),
    "TRANSACTION_TYPE": env("MPESA_TRANSACTION_TYPE", default="CustomerPayBillOnline"),  # or CustomerBuyGoodsOnline (till)
    "PARTY_B": env("MPESA_PARTY_B", default=""),  # till number for Buy Goods; blank = SHORTCODE
    "CALLBACK_URL": env("MPESA_CALLBACK_URL", default=""),  # blank = https://<this server>/api/mpesa/callback/?token=…
    "CALLBACK_TOKEN": env("MPESA_CALLBACK_TOKEN", default=env("INBOUND_TOKEN", default="change-me")),
}

# Google Maps (store locations and live tracking of transfers). A browser key restricted to your domain.
GOOGLE_MAPS_API_KEY = env("GOOGLE_MAPS_API_KEY", default="")

if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SECURE_SSL_REDIRECT = env.bool("SECURE_SSL_REDIRECT", default=True)
    SESSION_COOKIE_SECURE = CSRF_COOKIE_SECURE = True
    SECURE_HSTS_SECONDS = 31536000

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": "INFO"},
}
