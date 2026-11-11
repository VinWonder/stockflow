import os

from django.core.management.base import BaseCommand

from accounts.models import Business, User


class Command(BaseCommand):
    """Optional: creates a platform admin from ADMIN_USERNAME / ADMIN_PASSWORD if it doesn't exist yet.

    Not needed for clients any more: they open their own account from the app's "Create account" screen.
    This only gives you (the operator) a login for the back-office at /admin/. Never changes an existing account.
    """

    help = "Create the operator admin from ADMIN_USERNAME and ADMIN_PASSWORD (only if missing)."

    def handle(self, *args, **options):
        username = os.environ.get("ADMIN_USERNAME", "").strip()
        password = os.environ.get("ADMIN_PASSWORD", "")
        if not username or not password:
            self.stdout.write("ADMIN_USERNAME / ADMIN_PASSWORD not set; skipping (clients sign up in the app).")
            return
        if User.objects.filter(username__iexact=username).exists():
            self.stdout.write(f"Admin '{username}' already exists.")
            return
        business = Business.objects.create(name=os.environ.get("ADMIN_BUSINESS_NAME", "My Hardware"))
        User.objects.create_superuser(username=username, password=password, email=os.environ.get("ADMIN_EMAIL", ""),
                                      business=business)
        self.stdout.write(self.style.SUCCESS(f"Admin '{username}' created."))
