from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .models import Business, User


@admin.register(Business)
class BusinessAdmin(admin.ModelAdmin):
    list_display = ["name", "phone", "email", "created_at"]
    search_fields = ["name", "phone", "email"]


@admin.register(User)
class StockUserAdmin(UserAdmin):
    list_display = ["username", "get_full_name", "business", "role", "phone", "is_active"]
    list_filter = ["role", "is_active", "business"]
    fieldsets = UserAdmin.fieldsets + (("Stock control", {"fields": ("business", "role", "phone", "locations", "sms_alerts", "whatsapp_alerts")}),)
    filter_horizontal = ["locations", "groups", "user_permissions"]
