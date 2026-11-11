"""Existing installs had one shop owner: put all their data into one business, and mark old paid sales as paid."""
from decimal import Decimal

from django.db import migrations


def forwards(apps, schema_editor):
    Business = apps.get_model("accounts", "Business")
    User = apps.get_model("accounts", "User")
    models = [apps.get_model("inventory", n) for n in ("Location", "Category", "Product", "Supplier", "Customer")]
    has_data = User.objects.exists() or any(m.objects.exists() for m in models)
    if has_data:
        business = Business.objects.order_by("id").first() or Business.objects.create(name="My Hardware")
        User.objects.filter(business__isnull=True).update(business=business)
        for m in models:
            m.objects.filter(business__isnull=True).update(business=business)

    Sale = apps.get_model("inventory", "Sale")
    for sale in Sale.objects.exclude(payment_method="credit").filter(amount_paid=0).prefetch_related("lines"):
        total = sum((l.quantity * l.unit_price for l in sale.lines.all()), Decimal("0")) - sale.discount
        Sale.objects.filter(pk=sale.pk).update(amount_paid=max(Decimal("0"), total))


class Migration(migrations.Migration):
    dependencies = [("inventory", "0002_business_tracking_credit_mpesa")]
    operations = [migrations.RunPython(forwards, migrations.RunPython.noop)]
