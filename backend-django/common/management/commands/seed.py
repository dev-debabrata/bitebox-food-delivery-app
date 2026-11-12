"""
`manage.py seed`: fictional development data (same accounts as the Node seed).

    SEED_PASSWORD='Dev-pass-123' python manage.py seed [--reset-passwords]

Refuses to run with staging or production settings.
"""

import os
from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError, CommandParser

from common.seed import seed, valid_seed_password


class Command(BaseCommand):
    help = "Create fictional development data (idempotent)."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--reset-passwords",
            action="store_true",
            help="Set every seeded account's password to SEED_PASSWORD and sign them out.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        module = os.environ.get("DJANGO_SETTINGS_MODULE", "")
        if module.endswith(("production", "staging")) or (
            not settings.DEBUG and "test" not in module
        ):
            raise CommandError("Refusing to seed: these are not development settings.")
        password = os.environ.get("SEED_PASSWORD")
        if not valid_seed_password(password):
            raise CommandError("Set SEED_PASSWORD (8+ characters, a letter and a number).")
        report = seed(str(password), reset_passwords=options["reset_passwords"])
        for field, value in vars(report).items():
            self.stdout.write(f"{field.replace('_', ' ')}: {value}")
        self.stdout.write(
            self.style.WARNING(
                "Development-only accounts. All use SEED_PASSWORD. Never use these in production."
            )
        )
