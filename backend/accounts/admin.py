from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .models import User


@admin.register(User)
class StockUserAdmin(UserAdmin):
    list_display = ["username", "get_full_name", "role", "phone", "is_active"]
    list_filter = ["role", "is_active"]
    fieldsets = UserAdmin.fieldsets + (("Stock control", {"fields": ("role", "phone", "locations", "sms_alerts", "whatsapp_alerts")}),)
    filter_horizontal = ["locations", "groups", "user_permissions"]
