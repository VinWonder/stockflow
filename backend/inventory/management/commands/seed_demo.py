"""python manage.py seed_demo  — creates a demo business with stores, hardware products, a supplier, users and opening stock."""
from datetime import date
from decimal import Decimal as D

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction

from accounts.models import Business
from inventory import services
from inventory.models import Category, Location, Product, Receipt, ReceiptLine, Supplier, Variant

User = get_user_model()

CATALOGUE = [
    # category, icon, name, code, brand, unit, fractions, reorder, variants [(size, colour, cost, price)]
    ("Cement & building", "foundation", "Cement", "CEM", "Bamburi", "bag", False, 20, [("50kg", "", 720, 850)]),
    ("Paint", "format_paint", "Crown Silk Vinyl", "PNT", "Crown", "tin", False, 6,
     [("4L", "White", 2600, 3200), ("4L", "Cream", 2600, 3200), ("1L", "White", 750, 950), ("20L", "White", 11500, 13800)]),
    ("Fasteners", "hardware", "Wire nails", "NAIL", "", "kg", True, 10, [("3in", "", 160, 220), ("4in", "", 160, 220), ("2in", "", 170, 230)]),
    ("Roofing", "roofing", "Iron sheet", "IRS", "Mabati Rolling Mills", "sheet", False, 15,
     [("Gauge 30 3m", "Maroon", 820, 1050), ("Gauge 30 3m", "Green", 820, 1050), ("Gauge 28 3m", "Blue", 980, 1250)]),
    ("Plumbing", "plumbing", "PVC pipe", "PVC", "Kentainers", "pcs", False, 10, [("1/2in", "", 180, 260), ("1in", "", 320, 430), ("4in", "", 1450, 1900)]),
    ("Steel", "construction", "Steel bar", "Y12", "", "pcs", False, 30, [("Y12 12m", "", 980, 1150), ("Y10 12m", "", 720, 850)]),
    ("Electrical", "electrical_services", "Cable", "CBL", "East African Cables", "m", True, 50, [("2.5mm", "Red", 45, 70), ("2.5mm", "Black", 45, 70)]),
]


class Command(BaseCommand):
    help = "Load a demo business: stores, products, supplier, users and opening stock"

    @transaction.atomic
    def handle(self, *args, **opts):
        biz, _ = Business.objects.get_or_create(name="Demo Hardware", defaults={"phone": "254700000001"})

        def store(code, **kw):
            return Location.objects.get_or_create(business=biz, code=code, defaults=kw)[0]

        gdn = store("GDN", name="Home Godown", kind="godown", color="#7C3AED", can_sell=False,
                    address="Industrial Area, Nairobi", latitude=D("-1.308500"), longitude=D("36.851000"))
        main = store("MAIN", name="Main Shop", kind="shop", is_main=True, color="#2563EB",
                     address="Kirinyaga Road, Nairobi", latitude=D("-1.281900"), longitude=D("36.823300"))
        shp2 = store("SHP2", name="Shop 2 — Market", kind="shop", color="#059669",
                     address="Gikomba Market", latitude=D("-1.284700"), longitude=D("36.838900"))

        def person(username, password, **kw):
            user, created = User.objects.get_or_create(username=username, defaults={**kw, "business": biz})
            if created:
                user.set_password(password)
                user.save()
            return user

        person("admin", "admin12345", role="admin", phone="0700000001", first_name="Owner", email="owner@demo.local")
        manager = person("manager", "manager12345", role="manager", phone="0700000002", first_name="Godown", last_name="Manager")
        manager.locations.set([gdn, main])
        staff = person("shop2", "shop212345", role="staff", phone="0700000003", first_name="Shop 2")
        staff.locations.set([shp2])
        admin = User.objects.get(username="admin")

        supplier, _ = Supplier.objects.get_or_create(business=biz, name="Nairobi Hardware Distributors", defaults={
            "contact_person": "John Kamau", "phone": "0722000000"})

        variants = []
        for cat, icon, name, code, brand, unit, fractions, reorder, options in CATALOGUE:
            category, _ = Category.objects.get_or_create(business=biz, name=cat, defaults={"icon": icon})
            product, _ = Product.objects.get_or_create(business=biz, code=code, defaults={
                "name": name, "category": category, "brand": brand, "unit": unit, "allow_fractions": fractions,
                "reorder_level": D(reorder)})
            for size, colour, cost, price in options:
                v, _ = Variant.objects.get_or_create(product=product, size=size, colour=colour,
                                                     defaults={"selling_price": D(price)})
                variants.append((v, D(cost)))

        if not Receipt.objects.filter(location__business=biz).exists():
            for loc, factor in ((gdn, 10), (main, 3)):
                r = Receipt.objects.create(location=loc, supplier=supplier, supplied_on=date.today(),
                                           invoice_number=f"OPEN-{loc.code}", created_by=admin, notes="Opening stock")
                ReceiptLine.objects.bulk_create([ReceiptLine(receipt=r, variant=v, quantity=D(factor * 5), unit_cost=c)
                                                 for v, c in variants])
                services.post_receipt(r, admin)
        self.stdout.write(self.style.SUCCESS(
            "Demo ready. Logins: admin/admin12345 (phone 0700000001), manager/manager12345 (0700000002), shop2/shop212345"))
