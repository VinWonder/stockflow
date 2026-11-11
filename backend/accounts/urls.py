from django.urls import path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register("users", views.UserViewSet, basename="user")
urlpatterns = [
    path("auth/me/", views.me, name="me"),
    path("auth/register/", views.register, name="register"),
    path("auth/password/forgot/", views.forgot_password, name="password-forgot"),
    path("auth/password/verify/", views.verify_reset_code, name="password-verify"),
    path("auth/password/reset/", views.reset_password, name="password-reset"),
    path("auth/password/change/", views.change_password, name="password-change"),
    path("business/", views.business, name="business"),
] + router.urls
