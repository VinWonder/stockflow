from datetime import date
from decimal import Decimal as D

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase
from rest_framework.test import APIClient

from inventory import services
from inventory.exceptions import InsufficientStock, StockError
from inventory.models import Location, StockLevel, StockMovement, StockRequest, Supplier, Transfer, TransferLine, Variant
from messaging.handler import Unresolved, execute, handle_incoming
from messaging.models import Notification

User = get_user_model()


def qty(loc, variant):
    lv = StockLevel.objects.filter(location=loc, variant=variant).first()
    return lv.quantity if lv else D(0)


class StockFlowTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command("seed_demo", verbosity=0)

    def setUp(self):
        self.admin = User.objects.get(username="admin")
        self.manager = User.objects.get(username="manager")
        self.staff = User.objects.get(username="shop2")
        self.gdn = Location.objects.get(code="GDN")
        self.main = Location.objects.get(code="MAIN")
        self.shp2 = Location.objects.get(code="SHP2")
        self.cement = Variant.objects.get(sku="CEM-50KG")
        self.api = APIClient()

    def test_opening_stock_and_ledger_balance(self):
        self.assertEqual(qty(self.gdn, self.cement), D(50))
        total = sum(m.quantity for m in StockMovement.objects.filter(location=self.gdn, variant=self.cement))
        self.assertEqual(total, qty(self.gdn, self.cement))

    def test_transfer_full_cycle_with_shortage(self):
        t = Transfer.objects.create(source=self.gdn, destination=self.shp2, created_by=self.manager)
        line = TransferLine.objects.create(transfer=t, variant=self.cement, quantity=10)
        services.approve_transfer(t, self.admin)
        services.dispatch_transfer(t, self.manager)
        self.assertEqual(qty(self.gdn, self.cement), D(40))
        with self.captureOnCommitCallbacks(execute=True):
            services.receive_transfer(t, self.staff, {line.id: 9})
        self.assertEqual(qty(self.shp2, self.cement), D(9))
        t.refresh_from_db()
        self.assertTrue(t.has_discrepancy)
        self.assertTrue(Notification.objects.filter(user=self.admin, title__contains="short").exists())

    def test_manager_cannot_approve(self):
        t = Transfer.objects.create(source=self.gdn, destination=self.shp2, created_by=self.manager)
        TransferLine.objects.create(transfer=t, variant=self.cement, quantity=1)
        with self.assertRaises(StockError):
            services.approve_transfer(t, self.manager)

    def test_cannot_go_negative(self):
        t = Transfer.objects.create(source=self.gdn, destination=self.shp2, created_by=self.admin, status="approved")
        TransferLine.objects.create(transfer=t, variant=self.cement, quantity=999)
        with self.assertRaises(InsufficientStock):
            services.dispatch_transfer(t, self.admin)
        self.assertEqual(qty(self.gdn, self.cement), D(50))

    def test_sms_remove_confirm_approve(self):
        reply, _ = execute(self.admin, "REMOVE GDN: CEM 5 #damaged", "sms")
        req = StockRequest.objects.latest("id")
        self.assertEqual(req.status, "pending")
        self.assertIn(req.code, reply)
        execute(self.manager, f"DONE {req.code}", "sms")
        req.refresh_from_db()
        self.assertEqual(req.status, "confirmed")
        self.assertEqual(qty(self.gdn, self.cement), D(50))  # nothing changes before approval
        execute(self.admin, f"APPROVE {req.code}", "sms")
        self.assertEqual(qty(self.gdn, self.cement), D(45))

    def test_manager_reports_already_removed(self):
        execute(self.manager, "REMOVED GDN: PNT 4L CREAM 2", "whatsapp")
        req = StockRequest.objects.latest("id")
        self.assertEqual(req.status, "confirmed")
        self.assertEqual(req.lines.get().variant.sku, "PNT-4L-CREAM")

    def test_ambiguous_variant_lists_options(self):
        reply, _ = execute(self.manager, "REMOVE GDN: PNT 2", "sms")
        self.assertIn("several", reply)

    def test_unknown_phone_is_ignored(self):
        self.assertIsNone(handle_incoming("sms", "0799999999", "STOCK GDN CEM"))

    def test_staff_cannot_touch_other_store(self):
        with self.assertRaises(Unresolved):
            execute(self.staff, "STOCK GDN CEM", "sms")

    def test_sale_and_godown_cannot_sell(self):
        self.api.force_authenticate(self.manager)
        r = self.api.post("/api/sales/", {"location": self.main.id, "payment_method": "cash",
                                          "lines": [{"variant": self.cement.id, "quantity": "2"}]}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(qty(self.main, self.cement), D(13))
        r = self.api.post("/api/sales/", {"location": self.gdn.id, "lines": [{"variant": self.cement.id, "quantity": "1"}]}, format="json")
        self.assertEqual(r.status_code, 409)

    def test_idempotent_create(self):
        self.api.force_authenticate(self.admin)
        body = {"client_uuid": "4f8b1a52-5c1b-4d1e-9a7e-0d1e2f3a4b5c", "location": self.main.id,
                "lines": [{"variant": self.cement.id, "quantity": "1"}]}
        self.api.post("/api/sales/", body, format="json")
        self.api.post("/api/sales/", body, format="json")
        self.assertEqual(qty(self.main, self.cement), D(14))

    def test_receipt_api_updates_stock_and_cost(self):
        self.api.force_authenticate(self.admin)
        sup = Supplier.objects.first()
        r = self.api.post("/api/receipts/", {"location": self.gdn.id, "supplier": sup.id, "supplied_on": str(date.today()),
                                             "amount_paid": "0", "lines": [{"variant": self.cement.id, "quantity": "65", "unit_cost": "800"}]},
                          format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(qty(self.gdn, self.cement), D(115))
        self.cement.refresh_from_db()
        self.assertGreater(self.cement.cost_price, D(720))
        self.assertEqual(r.data["payment_status"], "unpaid")

    def test_stocktake(self):
        count = services.start_count(self.gdn, self.manager, [self.cement.id])
        line = count.lines.get()
        line.counted = D(47)
        line.save()
        services.submit_count(count, self.manager)
        services.post_count(count, self.admin)
        self.assertEqual(qty(self.gdn, self.cement), D(47))

    def test_dashboard_and_scoping(self):
        self.api.force_authenticate(self.staff)
        r = self.api.get("/api/locations/")
        codes = [l["code"] for l in r.data["results"]]
        self.assertEqual(codes, ["SHP2"])
        self.api.force_authenticate(self.admin)
        self.assertEqual(self.api.get("/api/dashboard/").status_code, 200)
