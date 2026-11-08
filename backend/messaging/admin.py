from django.contrib import admin

from .models import MessageLog, Notification


@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = ["title", "user", "kind", "needs_action", "is_read", "created_at"]
    list_filter = ["kind", "is_read", "needs_action"]


@admin.register(MessageLog)
class MessageLogAdmin(admin.ModelAdmin):
    list_display = ["created_at", "direction", "channel", "phone", "user", "status", "result"]
    list_filter = ["direction", "channel", "status"]
    search_fields = ["phone", "body", "result"]
    readonly_fields = [f.name for f in MessageLog._meta.fields]
