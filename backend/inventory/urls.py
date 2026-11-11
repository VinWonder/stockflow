from django.urls import path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register("locations", views.LocationViewSet, basename="location")
router.register("categories", views.CategoryViewSet, basename="category")
router.register("products", views.ProductViewSet, basename="product")
router.register("variants", views.VariantViewSet, basename="variant")
router.register("suppliers", views.SupplierViewSet, basename="supplier")
router.register("customers", views.CustomerViewSet, basename="customer")
router.register("stock", views.StockLevelViewSet, basename="stock")
router.register("movements", views.MovementViewSet, basename="movement")
router.register("receipts", views.ReceiptViewSet, basename="receipt")
router.register("transfers", views.TransferViewSet, basename="transfer")
router.register("requests", views.StockRequestViewSet, basename="request")
router.register("sales", views.SaleViewSet, basename="sale")
router.register("mpesa/stk", views.MpesaViewSet, basename="mpesa")
router.register("counts", views.StockCountViewSet, basename="count")

urlpatterns = [
    path("dashboard/", views.dashboard, name="dashboard"),
    path("stock-alerts/", views.stock_alerts, name="stock-alerts"),
    path("config/", views.app_config, name="app-config"),
    path("track/<str:token>/", views.driver_tracking, name="driver-tracking"),
    path("mpesa/callback/", views.mpesa_callback, name="mpesa-callback"),
] + router.urls
