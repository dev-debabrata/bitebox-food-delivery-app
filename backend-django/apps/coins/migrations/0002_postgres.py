"""Database-level immutability for the coin ledger (the models enforce the same rule in Python). PostgreSQL only; skipped on SQLite (local tests)."""

from django.db import migrations

from common.migration_ops import PostgresOnlySQL

LEDGER_GUARD = """
CREATE OR REPLACE FUNCTION coins_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LEDGER_IMMUTABLE: ledger rows cannot be deleted';
  END IF;
  -- The only allowed change: pending -> posted (and its timestamp), nothing else on the row.
  IF OLD.status = 'pending' AND NEW.status = 'posted'
     AND (to_jsonb(NEW) - 'status' - 'posted_at') = (to_jsonb(OLD) - 'status' - 'posted_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'LEDGER_IMMUTABLE: ledger rows cannot be edited';
END $$;
CREATE TRIGGER coin_transactions_immutable BEFORE UPDATE OR DELETE ON coin_transactions
  FOR EACH ROW EXECUTE FUNCTION coins_ledger_guard();

CREATE OR REPLACE FUNCTION coins_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_IMMUTABLE: ledger rows cannot be changed';
END $$;
CREATE TRIGGER coin_allocations_immutable BEFORE UPDATE OR DELETE ON coin_allocations
  FOR EACH ROW EXECUTE FUNCTION coins_allocation_guard();
"""

DROP_LEDGER_GUARD = """
DROP TRIGGER IF EXISTS coin_allocations_immutable ON coin_allocations;
DROP FUNCTION IF EXISTS coins_allocation_guard();
DROP TRIGGER IF EXISTS coin_transactions_immutable ON coin_transactions;
DROP FUNCTION IF EXISTS coins_ledger_guard();
"""


class Migration(migrations.Migration):
    dependencies = [("coins", "0001_initial")]
    operations = [
        PostgresOnlySQL(LEDGER_GUARD, DROP_LEDGER_GUARD),
    ]
