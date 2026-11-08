import secrets

from django.contrib.auth import get_user_model
from rest_framework import serializers

User = get_user_model()


class UserSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, required=False, min_length=8)
    full_name = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "username", "first_name", "last_name", "full_name", "email", "phone", "role",
                  "locations", "sms_alerts", "whatsapp_alerts", "is_active", "password"]

    def get_full_name(self, obj):
        return obj.get_full_name() or obj.username

    def create(self, data):
        password = data.pop("password", None)
        locations = data.pop("locations", [])
        user = User(**data)
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

    class Meta(UserSerializer.Meta):
        fields = UserSerializer.Meta.fields + ["is_admin"]
        read_only_fields = ["role", "locations", "username", "is_active"]
