from django.urls import path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register("notifications", views.NotificationViewSet, basename="notification")

urlpatterns = [
    path("messaging/config/", views.messaging_config, name="messaging-config"),
    path("messaging/simulate/", views.simulate, name="messaging-simulate"),
    path("messaging/log/", views.message_log, name="messaging-log"),
    path("inbound/sms/", views.inbound_sms, name="inbound-sms"),
    path("inbound/whatsapp/", views.inbound_whatsapp, name="inbound-whatsapp"),
] + router.urls
