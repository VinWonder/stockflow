import os

from django.core.management.base import BaseCommand

from accounts.models import User


class Command(BaseCommand):
    """Creates the first admin from ADMIN_USERNAME / ADMIN_PASSWORD if it doesn't exist yet.

    Runs on every start in the cloud (no shell there). Never changes an existing account,
    so changing the password later in the app or admin panel is kept.
    """

    help = "Create the admin account from ADMIN_USERNAME and ADMIN_PASSWORD (only if missing)."

    def handle(self, *args, **options):
        username = os.environ.get("ADMIN_USERNAME", "").strip()
        password = os.environ.get("ADMIN_PASSWORD", "")
        if not username or not password:
            self.stdout.write("ADMIN_USERNAME / ADMIN_PASSWORD not set; skipping admin creation.")
            return
        if User.objects.filter(username=username).exists():
            self.stdout.write(f"Admin '{username}' already exists.")
            return
        User.objects.create_superuser(username=username, password=password, email=os.environ.get("ADMIN_EMAIL", ""))
        self.stdout.write(self.style.SUCCESS(f"Admin '{username}' created."))
