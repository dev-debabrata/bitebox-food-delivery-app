"""Spatial index on saved addresses. PostgreSQL only; skipped on SQLite (local tests)."""

from django.db import migrations

from common.migration_ops import gist


class Migration(migrations.Migration):
    dependencies = [("customers", "0001_initial")]
    operations = [
        gist("addresses", "location"),
    ]
