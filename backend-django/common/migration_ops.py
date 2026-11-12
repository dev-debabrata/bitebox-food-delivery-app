"""
Migration operations that only apply to PostgreSQL. Local tests may run on SQLite, which has no
PostGIS, GIN or triggers; there these steps are skipped and the rest of the schema is the same.
"""

from typing import Any

from django.db import migrations


class PostgresOnlySQL(migrations.RunSQL):
    def database_forwards(
        self, app_label: str, schema_editor: Any, from_state: Any, to_state: Any
    ) -> None:
        if schema_editor.connection.vendor == "postgresql":
            super().database_forwards(app_label, schema_editor, from_state, to_state)

    def database_backwards(
        self, app_label: str, schema_editor: Any, from_state: Any, to_state: Any
    ) -> None:
        if schema_editor.connection.vendor == "postgresql":
            super().database_backwards(app_label, schema_editor, from_state, to_state)


def gist(table: str, column: str) -> PostgresOnlySQL:
    name = f"{table}_{column}_gist"
    return PostgresOnlySQL(
        f'CREATE INDEX IF NOT EXISTS "{name}" ON "{table}" USING GIST ("{column}")',
        f'DROP INDEX IF EXISTS "{name}"',
    )


def gin_jsonb(table: str, column: str) -> PostgresOnlySQL:
    """Index a JSON list (cuisines, tags) for `@>` containment filters."""
    name = f"{table}_{column}_gin"
    return PostgresOnlySQL(
        f'CREATE INDEX IF NOT EXISTS "{name}" ON "{table}" USING GIN ("{column}" jsonb_path_ops)',
        f'DROP INDEX IF EXISTS "{name}"',
    )


def trigram(table: str, column: str) -> PostgresOnlySQL:
    """Fast `ILIKE '%term%'` search on a text column (needs pg_trgm)."""
    name = f"{table}_{column}_trgm"
    return PostgresOnlySQL(
        f'CREATE INDEX IF NOT EXISTS "{name}" ON "{table}" USING GIN ("{column}" gin_trgm_ops)',
        f'DROP INDEX IF EXISTS "{name}"',
    )
