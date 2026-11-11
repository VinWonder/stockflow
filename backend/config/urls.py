from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.http import FileResponse, HttpResponse
from django.urls import include, path, re_path
from django.views.decorators.cache import never_cache
from rest_framework_simplejwt.views import TokenRefreshView

from accounts.views import LoginView

admin.site.site_header = "StockFlow"
admin.site.site_title = "StockFlow"


@never_cache
def web_app(request):
    """Every app address (/, /stores/3, /sell …) loads the web app; its own router shows the right screen."""
    index = settings.FRONTEND_DIR / "index.html"
    if not index.exists():
        return HttpResponse("The web app isn't built yet. Run `npm run build` in the web folder "
                            "(or use `npm run dev` while developing).", status=404, content_type="text/plain")
    return FileResponse(open(index, "rb"), content_type="text/html")


urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/auth/token/", LoginView.as_view(), name="token"),
    path("api/auth/refresh/", TokenRefreshView.as_view(), name="token-refresh"),
    path("api/", include("accounts.urls")),
    path("api/", include("inventory.urls")),
    path("api/", include("messaging.urls")),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT) + [
    re_path(r"^(?!api/|admin/|static/|media/).*$", web_app),
]
