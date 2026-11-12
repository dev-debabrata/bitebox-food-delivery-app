"""PostgreSQL extensions every other app relies on. Runs first (each app's 0001 depends on it)."""

from django.db import migrations

from common.migration_ops import PostgresOnlySQL


class Migration(migrations.Migration):
    initial = True
    dependencies: list[tuple[str, str]] = []
    operations = [
        PostgresOnlySQL("CREATE EXTENSION IF NOT EXISTS postgis", migrations.RunSQL.noop),
        PostgresOnlySQL("CREATE EXTENSION IF NOT EXISTS pg_trgm", migrations.RunSQL.noop),
    ]
