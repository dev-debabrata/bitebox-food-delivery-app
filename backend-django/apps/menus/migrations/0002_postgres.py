"""Dish search and tag indexes. PostgreSQL only; skipped on SQLite (local tests)."""

from django.db import migrations

from common.migration_ops import gin_jsonb, trigram


class Migration(migrations.Migration):
    dependencies = [("menus", "0001_initial")]
    operations = [
        trigram("food_items", "name"),  # dish search
        gin_jsonb("food_items", "tags"),
    ]
