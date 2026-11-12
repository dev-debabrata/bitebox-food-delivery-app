"""Spatial, cuisine and name-search indexes. PostgreSQL only; skipped on SQLite (local tests)."""

from django.db import migrations

from common.migration_ops import gin_jsonb, gist, trigram


class Migration(migrations.Migration):
    dependencies = [("restaurants", "0001_initial")]
    operations = [
        gist("restaurants", "location"),  # nearby restaurants (ST_DWithin)
        gin_jsonb("restaurants", "cuisines"),  # cuisine filter (@>)
        trigram("restaurants", "name"),  # search
    ]
