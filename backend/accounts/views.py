from django.contrib.auth import get_user_model
from rest_framework import permissions, viewsets
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .serializers import MeSerializer, UserSerializer

User = get_user_model()


class IsAdminRole(permissions.BasePermission):
    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.is_admin)


class UserViewSet(viewsets.ModelViewSet):
    queryset = User.objects.prefetch_related("locations").order_by("first_name", "username")
    serializer_class = UserSerializer
    permission_classes = [IsAdminRole]
    search_fields = ["username", "first_name", "last_name", "phone"]
    filterset_fields = ["role", "is_active"]


@api_view(["GET", "PATCH"])
def me(request):
    if request.method == "PATCH":
        s = MeSerializer(request.user, data=request.data, partial=True)
        s.is_valid(raise_exception=True)
        s.save()
    return Response(MeSerializer(request.user).data)
