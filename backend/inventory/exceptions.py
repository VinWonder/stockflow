from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import exception_handler


class StockError(Exception):
    """A business rule was broken (not enough stock, wrong status, no permission for a step)."""

    def __init__(self, message, code="stock_error", details=None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.details = details or {}


class InsufficientStock(StockError):
    def __init__(self, variant, location, available, requested):
        super().__init__(
            f"Not enough {variant.label} at {location.name}: {available:g} available, {requested:g} needed.",
            code="insufficient_stock",
            details={"variant": variant.id, "sku": variant.sku, "location": location.code,
                     "available": str(available), "requested": str(requested)},
        )


def api_exception_handler(exc, context):
    """Return business-rule errors as clean JSON the Flutter app can show in a snackbar."""
    if isinstance(exc, StockError):
        return Response({"detail": exc.message, "code": exc.code, "details": exc.details},
                        status=status.HTTP_409_CONFLICT)
    if isinstance(exc, PermissionError):
        return Response({"detail": str(exc), "code": "forbidden"}, status=status.HTTP_403_FORBIDDEN)
    return exception_handler(exc, context)
