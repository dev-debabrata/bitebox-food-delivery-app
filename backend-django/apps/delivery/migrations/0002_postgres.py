"""Spatial index for dispatch. PostgreSQL only; skipped on SQLite (local tests)."""

from django.db import migrations

from common.migration_ops import gist


class Migration(migrations.Migration):
    dependencies = [("delivery", "0001_initial")]
    operations = [
        gist("delivery_partners", "location"),  # nearest free rider (KNN <->)
    ]
