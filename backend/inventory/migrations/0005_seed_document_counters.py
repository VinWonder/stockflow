"""Start each business's document numbers after its highest existing number, so no code is repeated."""
import re

from django.db import migrations

DOCS = [("Receipt", "GRN", "location"), ("Sale", "SAL", "location"), ("StockRequest", "SR", "location"),
        ("StockCount", "CNT", "location"), ("Transfer", "TRF", "source")]


def forwards(apps, schema_editor):
    Counter = apps.get_model("inventory", "DocumentCounter")
    highest = {}
    for model_name, prefix, loc_field in DOCS:
        Model = apps.get_model("inventory", model_name)
        for code, biz in Model.objects.exclude(code=None).values_list("code", f"{loc_field}__business_id"):
            m = re.search(r"(\d+)$", code or "")
            if biz and m:
                key = (biz, prefix)
                highest[key] = max(highest.get(key, 0), int(m.group(1)))
    for (biz, prefix), last in highest.items():
        Counter.objects.update_or_create(business_id=biz, prefix=prefix, defaults={"last": last})


class Migration(migrations.Migration):
    dependencies = [("inventory", "0004_per_business_numbers_mpesa_c2b")]
    operations = [migrations.RunPython(forwards, migrations.RunPython.noop)]
