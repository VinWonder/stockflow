import django.conf
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("inventory", "0005_seed_document_counters"),
        migrations.swappable_dependency(django.conf.settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="receipt",
            name="next_payment_date",
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="transfer",
            name="driver_arrived_at",
            field=models.DateTimeField(
                blank=True,
                help_text="When the driver reported arrival at the destination",
                null=True,
            ),
        ),
        migrations.CreateModel(
            name="ReceiptPayment",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("amount", models.DecimalField(decimal_places=2, max_digits=14)),
                ("method", models.CharField(
                    choices=[
                        ("cash", "Cash"),
                        ("mpesa", "M-Pesa"),
                        ("bank", "Bank transfer"),
                        ("cheque", "Cheque"),
                    ],
                    max_length=10,
                )),
                ("reference", models.CharField(blank=True, max_length=80)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("received_by", models.ForeignKey(
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name="+",
                    to=django.conf.settings.AUTH_USER_MODEL,
                )),
                ("receipt", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="payments",
                    to="inventory.receipt",
                )),
            ],
            options={"ordering": ["created_at"]},
        ),
    ]
