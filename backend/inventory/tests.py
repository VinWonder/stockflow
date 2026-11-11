from datetime import date
from decimal import Decimal as D

from django.contrib.auth import get_user_model
from django.core import mail
from django.core.management import call_command
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import Business
from inventory import services
from inventory.exceptions import InsufficientStock, StockError
from inventory.models import (Customer, Location, Sale, StockLevel, StockMovement, StockRequest, Supplier, Transfer,
                              TransferLine, Variant)
from messaging.handler import Unresolved, execute, handle_incoming
from messaging.models import Notification

User = get_user_model()

DRIVER = {"driver_name": "Otieno", "driver_phone": "0711222333", "vehicle_type": "tuktuk", "vehicle_reg": "KMEA 123B"}


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

    # ------------------------------------------------------------------ ledger & transfers
    def test_opening_stock_and_ledger_balance(self):
        self.assertEqual(qty(self.gdn, self.cement), D(50))
        total = sum(m.quantity for m in StockMovement.objects.filter(location=self.gdn, variant=self.cement))
        self.assertEqual(total, qty(self.gdn, self.cement))

    def test_transfer_full_cycle_with_shortage(self):
        t = Transfer.objects.create(source=self.gdn, destination=self.shp2, created_by=self.manager)
        line = TransferLine.objects.create(transfer=t, variant=self.cement, quantity=10)
        services.approve_transfer(t, self.admin)
        services.dispatch_transfer(t, self.manager, DRIVER)
        self.assertEqual(qty(self.gdn, self.cement), D(40))
        t.refresh_from_db()
        self.assertEqual(t.driver_phone, "254711222333")
        self.assertEqual(t.vehicle_reg, "KMEA 123B")
        self.assertTrue(t.tracking_token)
        with self.captureOnCommitCallbacks(execute=True):
            services.receive_transfer(t, self.staff, {line.id: 9})
        self.assertEqual(qty(self.shp2, self.cement), D(9))
        t.refresh_from_db()
        self.assertTrue(t.has_discrepancy)
        self.assertTrue(Notification.objects.filter(user=self.admin, title__contains="short").exists())

    def test_dispatch_needs_driver_and_number_plate(self):
        t = Transfer.objects.create(source=self.gdn, destination=self.shp2, created_by=self.admin, status="approved")
        TransferLine.objects.create(transfer=t, variant=self.cement, quantity=1)
        with self.assertRaises(StockError):
            services.dispatch_transfer(t, self.admin, {})
        with self.assertRaises(StockError):  # motorbike without a plate
            services.dispatch_transfer(t, self.admin, {**DRIVER, "vehicle_type": "motorbike", "vehicle_reg": ""})
        services.dispatch_transfer(t, self.admin, {**DRIVER, "vehicle_type": "handcart", "vehicle_reg": ""})
        self.assertEqual(qty(self.gdn, self.cement), D(49))

    def test_live_tracking_by_driver_link_and_arrival_alert(self):
        t = Transfer.objects.create(source=self.gdn, destination=self.main, created_by=self.admin, status="approved")
        TransferLine.objects.create(transfer=t, variant=self.cement, quantity=2)
        services.dispatch_transfer(t, self.admin, DRIVER)
        t.refresh_from_db()
        anon = APIClient()
        r = anon.post(f"/api/track/{t.tracking_token}/", {"lat": "-1.300000", "lng": "36.840000", "speed": 5}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertGreater(r.data["distance_left_m"], 1000)
        self.assertIsNotNone(r.data["eta_minutes"])
        with self.captureOnCommitCallbacks(execute=True):
            from django.utils import timezone
            from datetime import timedelta

            t.track_points.update(recorded_at=timezone.now() - timedelta(seconds=10))
            anon.post(f"/api/track/{t.tracking_token}/", {"lat": "-1.282000", "lng": "36.823400"}, format="json")
        t.refresh_from_db()
        self.assertIsNotNone(t.arrived_near_at)
        self.assertTrue(Notification.objects.filter(title__contains="arriving").exists())
        self.assertEqual(anon.get("/api/track/not-a-token/").status_code, 404)
        self.api.force_authenticate(self.admin)
        track = self.api.get(f"/api/transfers/{t.id}/track/").data
        self.assertEqual(len(track["points"]), 2)
        detail = self.api.get(f"/api/transfers/{t.id}/").data
        self.assertTrue(detail["driver_link"].endswith(f"/drive/{t.tracking_token}"))
        self.assertTrue(detail["driver_link"].startswith("http"))
        self.assertFalse(self.api.get("/api/config/").data["sms_live"])
        services.receive_transfer(t, self.admin)
        r = anon.post(f"/api/track/{t.tracking_token}/", {"lat": "-1.28", "lng": "36.82"}, format="json")
        self.assertEqual(r.status_code, 409)  # tracking ends when the goods are received

    def test_manager_cannot_approve(self):
        t = Transfer.objects.create(source=self.gdn, destination=self.shp2, created_by=self.manager)
        TransferLine.objects.create(transfer=t, variant=self.cement, quantity=1)
        with self.assertRaises(StockError):
            services.approve_transfer(t, self.manager)

    def test_cannot_go_negative(self):
        t = Transfer.objects.create(source=self.gdn, destination=self.shp2, created_by=self.admin, status="approved")
        TransferLine.objects.create(transfer=t, variant=self.cement, quantity=999)
        with self.assertRaises(InsufficientStock):
            services.dispatch_transfer(t, self.admin, DRIVER)
        self.assertEqual(qty(self.gdn, self.cement), D(50))

    # ------------------------------------------------------------------ SMS / WhatsApp
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

    # ------------------------------------------------------------------ remove / add
    def test_admin_apply_now_changes_stock_in_one_step(self):
        self.api.force_authenticate(self.admin)
        r = self.api.post("/api/requests/", {"kind": "remove", "location": self.gdn.id, "reason": "damaged", "apply_now": True,
                                             "lines": [{"variant": self.cement.id, "quantity": "3"}]}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["status"], "approved")
        self.assertEqual(qty(self.gdn, self.cement), D(47))
        # Managers can't skip the admin.
        self.api.force_authenticate(self.manager)
        r = self.api.post("/api/requests/", {"kind": "remove", "location": self.gdn.id, "apply_now": True,
                                             "lines": [{"variant": self.cement.id, "quantity": "1"}]}, format="json")
        self.assertEqual(r.data["status"], "pending")

    # ------------------------------------------------------------------ sales, M-Pesa, credit
    def test_sale_and_switched_off_store_cannot_sell(self):
        self.api.force_authenticate(self.manager)
        r = self.api.post("/api/sales/", {"location": self.main.id, "payment_method": "cash",
                                          "lines": [{"variant": self.cement.id, "quantity": "2"}]}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(qty(self.main, self.cement), D(13))
        self.assertEqual(r.data["payment_status"], "paid")
        r = self.api.post("/api/sales/", {"location": self.gdn.id, "lines": [{"variant": self.cement.id, "quantity": "1"}]}, format="json")
        self.assertEqual(r.status_code, 409)
        # The owner can switch selling on at the godown.
        self.api.force_authenticate(self.admin)
        self.api.patch(f"/api/locations/{self.gdn.id}/", {"can_sell": True}, format="json")
        r = self.api.post("/api/sales/", {"location": self.gdn.id, "lines": [{"variant": self.cement.id, "quantity": "1"}]}, format="json")
        self.assertEqual(r.status_code, 201, r.data)

    def test_mpesa_code_is_checked_and_cannot_be_reused(self):
        self.api.force_authenticate(self.admin)
        body = {"location": self.main.id, "payment_method": "mpesa", "lines": [{"variant": self.cement.id, "quantity": "1"}]}
        r = self.api.post("/api/sales/", {**body, "payment_reference": "abc"}, format="json")
        self.assertEqual(r.status_code, 409)
        r = self.api.post("/api/sales/", {**body, "payment_reference": "skl4abcd12"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["payment_reference"], "SKL4ABCD12")
        r = self.api.post("/api/sales/", {**body, "payment_reference": "SKL4ABCD12"}, format="json")
        self.assertEqual(r.status_code, 409)
        self.assertEqual(qty(self.main, self.cement), D(14))

    def test_mpesa_prompt_pays_sale(self):
        self.api.force_authenticate(self.admin)
        r = self.api.post("/api/mpesa/stk/", {"location": self.main.id, "phone": "0712345678", "amount": "850"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["status"], "success")  # console backend pretends the customer paid
        pid = r.data["id"]
        sale = self.api.post("/api/sales/", {"location": self.main.id, "payment_method": "mpesa", "mpesa_payment": pid,
                                             "lines": [{"variant": self.cement.id, "quantity": "1"}]}, format="json")
        self.assertEqual(sale.status_code, 201, sale.data)
        self.assertTrue(sale.data["payment_reference"].startswith("SIM"))
        again = self.api.post("/api/sales/", {"location": self.main.id, "payment_method": "mpesa", "mpesa_payment": pid,
                                              "lines": [{"variant": self.cement.id, "quantity": "1"}]}, format="json")
        self.assertEqual(again.status_code, 409)  # one payment, one sale

    def test_credit_sale_limit_and_repayment(self):
        self.api.force_authenticate(self.admin)
        body = {"location": self.main.id, "payment_method": "credit",
                "lines": [{"variant": self.cement.id, "quantity": "2"}]}
        r = self.api.post("/api/sales/", body, format="json")
        self.assertEqual(r.status_code, 400)  # needs the customer
        r = self.api.post("/api/sales/", {**body, "customer_name": "Mama Njeri", "customer_phone": "0722111222",
                                          "deposit": "500"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(D(r.data["balance"]), D(1200))
        self.assertEqual(r.data["payment_status"], "partial")
        customer = Customer.objects.get(phone="254722111222")
        customer.credit_limit = D(1500)
        customer.save()
        r2 = self.api.post("/api/sales/", {**body, "customer": customer.id}, format="json")
        self.assertEqual(r2.status_code, 409)  # 1200 owed + 1700 > 1500
        self.assertEqual(r2.data["code"], "credit_limit")
        pay = self.api.post(f"/api/sales/{r.data['id']}/pay/", {"amount": "1200", "method": "cash"}, format="json")
        self.assertEqual(pay.status_code, 200, pay.data)
        self.assertEqual(pay.data["payment_status"], "paid")
        owing = self.api.get("/api/customers/?owing=1").data
        self.assertEqual(owing["count"], 0)
        dash = self.api.get("/api/dashboard/").data["totals"]
        self.assertEqual(D(dash["sales_today"]), D(1700))
        self.assertEqual(D(dash["profit_today"]), D(1700) - 2 * self.cement.cost_price)

    def test_idempotent_create(self):
        self.api.force_authenticate(self.admin)
        body = {"client_uuid": "4f8b1a52-5c1b-4d1e-9a7e-0d1e2f3a4b5c", "location": self.main.id,
                "lines": [{"variant": self.cement.id, "quantity": "1"}]}
        self.api.post("/api/sales/", body, format="json")
        self.api.post("/api/sales/", body, format="json")
        self.assertEqual(qty(self.main, self.cement), D(14))

    # ------------------------------------------------------------------ deliveries
    def test_receipt_api_updates_stock_cost_and_supplier_products(self):
        self.api.force_authenticate(self.admin)
        sup = Supplier.objects.create(business=self.admin.business, name="Bamburi Direct")
        r = self.api.post("/api/receipts/", {"location": self.gdn.id, "supplier": sup.id, "supplied_on": str(date.today()),
                                             "amount_paid": "0", "lines": [{"variant": self.cement.id, "quantity": "65", "unit_cost": "800"}]},
                          format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(qty(self.gdn, self.cement), D(115))
        self.cement.refresh_from_db()
        self.assertGreater(self.cement.cost_price, D(720))
        self.assertEqual(r.data["payment_status"], "unpaid")
        listed = self.api.get(f"/api/variants/?supplier={sup.id}").data["results"]
        self.assertEqual([v["sku"] for v in listed], ["CEM-50KG"])

    def test_create_product_with_sizes_in_app(self):
        self.api.force_authenticate(self.admin)
        r = self.api.post("/api/products/", {"name": "Gate valve", "unit": "pcs", "reorder_level": "4",
                                             "new_variants": [{"size": "1/2in", "selling_price": "650"},
                                                              {"size": "1in", "selling_price": "980"}]}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(len(r.data["variants"]), 2)
        self.assertEqual(r.data["code"], "GATE")
        self.api.force_authenticate(self.staff)
        self.assertEqual(self.api.post("/api/products/", {"name": "X"}, format="json").status_code, 403)

    def test_stocktake(self):
        count = services.start_count(self.gdn, self.manager, [self.cement.id])
        line = count.lines.get()
        line.counted = D(47)
        line.save()
        services.submit_count(count, self.manager)
        services.post_count(count, self.admin)
        self.assertEqual(qty(self.gdn, self.cement), D(47))

    # ------------------------------------------------------------------ dashboard & alerts
    def test_dashboard_per_store_and_scoping(self):
        self.api.force_authenticate(self.staff)
        codes = [l["code"] for l in self.api.get("/api/locations/").data]
        self.assertEqual(codes, ["SHP2"])
        self.api.force_authenticate(self.admin)
        all_value = D(self.api.get("/api/dashboard/").data["totals"]["stock_value"])
        gdn_value = D(self.api.get(f"/api/dashboard/?location={self.gdn.id}").data["totals"]["stock_value"])
        self.assertGreater(all_value, gdn_value)
        self.assertGreater(gdn_value, 0)

    def test_low_and_out_of_stock_states(self):
        self.api.force_authenticate(self.admin)
        sale = {"location": self.main.id, "lines": [{"variant": self.cement.id, "quantity": "15"}]}
        self.assertEqual(self.api.post("/api/sales/", sale, format="json").status_code, 201)
        out = self.api.get("/api/stock/?state=out").data["results"]
        self.assertIn(("MAIN", "CEM-50KG"), [(o["location_code"], o["variant"]["sku"]) for o in out])
        alerts = self.api.get(f"/api/stock-alerts/?location={self.main.id}").data
        self.assertGreaterEqual(alerts["out"], 1)


class AccountTests(TestCase):
    def setUp(self):
        from django.core.cache import cache

        cache.clear()  # sign-up and login are rate-limited per address
        self.api = APIClient()

    def register(self, email="owner@shop.co.ke", phone="0733000111", **extra):
        sent = self.api.post("/api/auth/register/code/", {"email": email}, format="json")
        code = mail.outbox[-1].subject.split()[-1] if sent.status_code == 200 else "000000"
        return self.api.post("/api/auth/register/", {
            "email_code": code,
            "business_name": "Kamau Hardware", "full_name": "Peter Kamau", "email": email, "phone": phone,
            "password": "Strong-pass-2026", "main_shop": {"name": "Kamau Main Shop", "address": "Thika Rd"},
            "stores": [{"name": "Ruiru Godown", "kind": "godown"}, {"name": "Juja Shop", "kind": "shop"}], **extra,
        }, format="json")

    def test_sign_up_creates_business_main_shop_and_stores(self):
        bad = self.api.post("/api/auth/register/", {"email": "x@y.co", "email_code": "123456", "business_name": "X",
                                                    "full_name": "X", "phone": "0733000999", "password": "Strong-pass-2026",
                                                    "main_shop": {"name": "X"}}, format="json")
        self.assertEqual(bad.status_code, 400)  # no code was sent to that email
        r = self.register()
        self.assertEqual(r.status_code, 201, r.data)
        self.assertNotIn("access", r.data)  # the owner signs in after creating the account
        user = User.objects.get(email="owner@shop.co.ke")
        self.assertTrue(user.is_admin)
        stores = Location.objects.filter(business=user.business)
        self.assertEqual(stores.count(), 3)
        main = stores.get(is_main=True)
        self.assertEqual(main.name, "Kamau Main Shop")
        self.assertFalse(stores.get(kind="godown").can_sell)
        # same email can't sign up twice
        self.assertEqual(self.register(phone="0733000222").status_code, 400)

    def test_login_with_email(self):
        self.register()
        r = self.api.post("/api/auth/token/", {"username": "OWNER@shop.co.ke", "password": "Strong-pass-2026"}, format="json")
        self.assertEqual(r.status_code, 200, r.data)

    def test_businesses_cannot_see_each_other(self):
        call_command("seed_demo", verbosity=0)
        self.register()
        owner = User.objects.get(email="owner@shop.co.ke")
        self.api.force_authenticate(owner)
        self.assertEqual(len(self.api.get("/api/locations/").data), 3)
        self.assertEqual(self.api.get("/api/products/").data["count"], 0)
        self.assertEqual(self.api.get("/api/stock/").data["count"], 0)
        demo_cement = Variant.objects.get(sku="CEM-50KG", product__business__name="Demo Hardware")
        demo_main = Location.objects.get(code="MAIN", business__name="Demo Hardware")
        my_main = Location.objects.get(business=owner.business, is_main=True)
        r = self.api.post("/api/sales/", {"location": demo_main.id, "lines": [{"variant": demo_cement.id, "quantity": "1"}]}, format="json")
        self.assertIn(r.status_code, (400, 403))
        r = self.api.post("/api/sales/", {"location": my_main.id, "lines": [{"variant": demo_cement.id, "quantity": "1"}]}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.api.get(f"/api/dashboard/?location={demo_main.id}").status_code, 403)
        # Same store codes and SKUs can exist in two businesses.
        self.api.post("/api/products/", {"name": "Cement", "code": "CEM", "new_variants": [{"size": "50kg"}]}, format="json")
        self.assertEqual(Variant.objects.filter(sku="CEM-50KG").count(), 2)

    def test_forgot_password_by_email_code(self):
        self.register()
        r = self.api.post("/api/auth/password/forgot/", {"email": "owner@shop.co.ke"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(mail.outbox), 2)  # sign-up code, then reset code
        code = mail.outbox[-1].subject.split()[-1]
        self.assertEqual(len(code), 6)
        bad = self.api.post("/api/auth/password/reset/", {"email": "owner@shop.co.ke", "code": "000000" if code != "000000" else "111111",
                                                          "new_password": "Another-pass-77"}, format="json")
        self.assertEqual(bad.status_code, 400)
        ok = self.api.post("/api/auth/password/reset/", {"email": "owner@shop.co.ke", "code": code,
                                                         "new_password": "Another-pass-77"}, format="json")
        self.assertEqual(ok.status_code, 200, ok.data)
        login = self.api.post("/api/auth/token/", {"username": "owner@shop.co.ke", "password": "Another-pass-77"}, format="json")
        self.assertEqual(login.status_code, 200)
        reuse = self.api.post("/api/auth/password/reset/", {"email": "owner@shop.co.ke", "code": code,
                                                            "new_password": "Third-pass-88"}, format="json")
        self.assertEqual(reuse.status_code, 400)
        # Unknown emails get the same answer and no email.
        r = self.api.post("/api/auth/password/forgot/", {"email": "nobody@x.com"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(mail.outbox), 2)

    def test_owner_adds_staff_in_app(self):
        self.register()
        owner = User.objects.get(email="owner@shop.co.ke")
        shop = Location.objects.get(business=owner.business, name="Juja Shop")
        self.api.force_authenticate(owner)
        r = self.api.post("/api/users/", {"username": "juja1", "first_name": "Wanjiru", "role": "staff", "phone": "0744555666",
                                          "password": "Juja-shop-2026", "locations": [shop.id]}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        staff = User.objects.get(username="juja1")
        self.assertEqual(staff.business, owner.business)
        self.assertEqual(staff.accessible_location_ids(), [shop.id])
        other = Business.objects.create(name="Other")
        foreign = Location.objects.create(business=other, code="X", name="Foreign")
        r = self.api.patch(f"/api/users/{staff.id}/", {"locations": [foreign.id]}, format="json")
        self.assertEqual(r.status_code, 400)


class ScreenEndpointTests(TestCase):
    """Every endpoint the web app's screens call answers for each role."""

    @classmethod
    def setUpTestData(cls):
        call_command("seed_demo", verbosity=0)

    def test_screen_endpoints(self):
        api = APIClient()
        admin = User.objects.get(username="admin")
        main = Location.objects.get(code="MAIN")
        sup = Supplier.objects.first()
        api.force_authenticate(admin)
        urls = [
            "/api/config/", "/api/auth/me/", "/api/business/", "/api/locations/", "/api/locations/directory/",
            "/api/dashboard/", f"/api/dashboard/?location={main.id}", "/api/stock-alerts/", "/api/stock/?state=alert",
            "/api/stock/?state=low", "/api/suppliers/", f"/api/suppliers/{sup.id}/products/", "/api/customers/",
            "/api/customers/?owing=1", "/api/products/?search=paint", "/api/categories/", "/api/users/",
            "/api/transfers/?status_in=requested,approved,in_transit", "/api/requests/?status_in=confirmed",
            "/api/notifications/", "/api/notifications/unread/", "/api/messaging/config/", "/api/messaging/log/",
            "/api/variants/?search=4L&is_active=true", "/api/sales/?owing=1",
        ]
        for url in urls:
            with self.subTest(url=url):
                self.assertEqual(api.get(url).status_code, 200, url)
        sup_row = api.get("/api/suppliers/").data["results"][0]
        self.assertGreater(sup_row["product_count"], 0)
        self.assertGreater(D(sup_row["total_supplied"]), 0)
        r = api.patch("/api/auth/me/", {"first_name": "Mama", "phone": "0700000001"}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(api.patch("/api/business/", {"name": "Demo Hardware Ltd"}, format="json").data["name"], "Demo Hardware Ltd")
        # Staff can read their screens but not the owner's.
        api.force_authenticate(User.objects.get(username="shop2"))
        for url in ("/api/dashboard/", "/api/locations/directory/", "/api/stock-alerts/", "/api/customers/?owing=1"):
            with self.subTest(url=url):
                self.assertEqual(api.get(url).status_code, 200, url)
        self.assertEqual(api.get("/api/users/").status_code, 403)
        self.assertEqual(api.get("/api/messaging/log/").status_code, 403)


class NewFeatureTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command("seed_demo", verbosity=0)

    def setUp(self):
        self.admin = User.objects.get(username="admin")
        self.main = Location.objects.get(code="MAIN")
        self.gdn = Location.objects.get(code="GDN")
        self.cement = Variant.objects.get(sku="CEM-50KG")
        self.api = APIClient()
        self.api.force_authenticate(self.admin)

    def test_products_typed_during_delivery_join_the_catalogue(self):
        sup = Supplier.objects.first()
        body = {"location": self.gdn.id, "supplier": sup.id, "supplied_on": str(date.today()), "invoice_number": "INV-889",
                "new_products": [{"name": "Gate valve", "size": '1/2"', "unit": "pcs", "category": "Taps",
                                  "quantity": "10", "unit_cost": "400", "selling_price": "650"}]}
        r = self.api.post("/api/receipts/", body, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        v = Variant.objects.get(product__name="Gate valve", size='1/2"')
        self.assertEqual(qty(self.gdn, v), D(10))
        self.assertEqual(v.product.category.name, "Taps")
        self.assertIn(sup, v.product.suppliers.all())
        # Typed again later: the same catalogue item is reused, not duplicated.
        body["client_uuid"] = None
        body["new_products"][0]["name"] = "gate VALVE"
        self.assertEqual(self.api.post("/api/receipts/", body, format="json").status_code, 201)
        self.assertEqual(Variant.objects.filter(product__name__iexact="gate valve").count(), 1)
        self.assertEqual(qty(self.gdn, v), D(20))

    def test_typed_category_on_product(self):
        r = self.api.post("/api/products/", {"name": "Water tank", "new_category": "Tanks",
                                             "new_variants": [{"size": "1000L"}, {"size": "5000L"}]}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["category_name"], "Tanks")

    def test_each_business_numbers_from_one(self):
        other = Business.objects.create(name="Second Shop")
        loc = Location.objects.create(business=other, code="MAIN", name="Main")
        from inventory.models import Sale as SaleModel

        first = SaleModel.objects.create(location=loc)
        self.assertEqual(first.code, "SAL00001")

    def test_typed_mpesa_code_must_be_a_real_safaricom_payment(self):
        from django.test import override_settings
        from inventory import mpesa

        biz = self.admin.business
        biz.mpesa_shortcode = "600999"
        biz.save()
        body = {"location": self.main.id, "payment_method": "mpesa", "lines": [{"variant": self.cement.id, "quantity": "1"}]}
        with override_settings(), self.settings():
            mpesa.CFG["BACKEND"] = "daraja"
            try:
                r = self.api.post("/api/sales/", {**body, "payment_reference": "SKL4ABCD12"}, format="json")
                self.assertEqual(r.status_code, 409)
                self.assertEqual(r.data["code"], "mpesa_not_found")
                # Safaricom reports the payment to our confirmation URL.
                token = mpesa.CFG["CALLBACK_TOKEN"]
                anon = APIClient()
                ok = anon.post(f"/api/payments/c2b/confirm/?token={token}", {
                    "TransactionType": "Buy Goods", "TransID": "SKL4ABCD12", "TransTime": "20261111093000",
                    "TransAmount": "850.00", "BusinessShortCode": "600999", "FirstName": "JANE"}, format="json")
                self.assertEqual(ok.status_code, 200)
                self.assertEqual(anon.post("/api/payments/c2b/confirm/?token=wrong", {}, format="json").status_code, 403)
                check = self.api.get("/api/mpesa/code/skl4abcd12/").data
                self.assertTrue(check["found"])
                self.assertEqual(check["payer"], "JANE")
                r = self.api.post("/api/sales/", {**body, "payment_reference": "SKL4ABCD12"}, format="json")
                self.assertEqual(r.status_code, 201, r.data)
                r = self.api.post("/api/sales/", {**body, "payment_reference": "SKL4ABCD12"}, format="json")
                self.assertEqual(r.status_code, 409)  # already used
                short = {**body, "lines": [{"variant": self.cement.id, "quantity": "2"}], "payment_reference": "SKL4ABCD99"}
                anon.post(f"/api/payments/c2b/confirm/?token={token}", {"TransID": "SKL4ABCD99", "TransAmount": "850",
                                                                       "BusinessShortCode": "600999"}, format="json")
                self.assertEqual(self.api.post("/api/sales/", short, format="json").data["code"], "mpesa_short")
            finally:
                mpesa.CFG["BACKEND"] = "console"
