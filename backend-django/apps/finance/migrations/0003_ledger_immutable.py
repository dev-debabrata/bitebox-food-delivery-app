"""Database-level immutability for the finance ledger (like the coin ledger). PostgreSQL only."""

from django.db import migrations

from common.migration_ops import PostgresOnlySQL

GUARD = """
CREATE OR REPLACE FUNCTION finance_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_IMMUTABLE: ledger rows cannot be changed';
END $$;
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION finance_ledger_guard();
"""

DROP = """
DROP TRIGGER IF EXISTS ledger_entries_immutable ON ledger_entries;
DROP FUNCTION IF EXISTS finance_ledger_guard();
"""


class Migration(migrations.Migration):
    dependencies = [("finance", "0002_commission_ledger_invoices")]
    operations = [PostgresOnlySQL(GUARD, DROP)]
