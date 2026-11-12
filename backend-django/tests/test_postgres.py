"""
The PostgreSQL-only parts of the schema (skipped on SQLite): PostGIS columns and queries, the
spatial/JSON/trigram indexes, and the database trigger that keeps the coin ledger immutable even
for raw SQL.
"""

from typing import Any

import pytest
from django.db import DatabaseError, connection, transaction

from apps.coins.models import CoinTransaction, CoinWallet
from apps.delivery.models import DeliveryPartner
from apps.rbac.roles import Role
from common.geo import GeoPoint
from tests import factories as make

pytestmark = [
    pytest.mark.django_db,
    pytest.mark.skipif(connection.vendor != "postgresql", reason="PostgreSQL only"),
]


def scalar(sql: str, params: tuple[Any, ...] = ()) -> object:
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        row = cursor.fetchone()
        return row[0] if row else None


def test_extensions_are_installed() -> None:
    names = {
        scalar("select extname from pg_extension where extname = %s", (n,))
        for n in ("postgis", "pg_trgm")
    }
    assert names == {"postgis", "pg_trgm"}


@pytest.mark.parametrize(
    ("table", "column"),
    [
        ("addresses", "location"),
        ("restaurants", "location"),
        ("delivery_partners", "location"),
        ("orders", "delivery_location"),
    ],
)
def test_points_are_geography_columns(table: str, column: str) -> None:
    kind = scalar(
        "select format_type(atttypid, atttypmod) from pg_attribute "
        "where attrelid = %s::regclass and attname = %s",
        (table, column),
    )
    assert kind == "geography(Point,4326)"


@pytest.mark.parametrize(
    "index",
    [
        "addresses_location_gist",
        "restaurants_location_gist",
        "delivery_partners_location_gist",
        "restaurants_cuisines_gin",
        "restaurants_name_trgm",
        "food_items_name_trgm",
        "food_items_tags_gin",
    ],
)
def test_postgres_indexes_exist(index: str) -> None:
    assert scalar("select 1 from pg_indexes where indexname = %s", (index,)) == 1


def test_points_round_trip_and_distance_runs_in_postgis() -> None:
    kitchen = make.restaurant(location=GeoPoint(lat=12.9719, lng=77.6412))
    kitchen.refresh_from_db()
    assert kitchen.location == GeoPoint(lat=12.9719, lng=77.6412)  # read back from EWKB

    metres = scalar(
        "select ST_Distance(location, ST_GeogFromText('SRID=4326;POINT(77.6271 12.9352)')) "
        "from restaurants where id = %s",
        (kitchen.pk,),
    )
    assert (
        4_200 < float(str(metres)) < 4_500
    )  # same straight-line distance as common.geo.haversine_m


def test_nearest_rider_query_uses_knn() -> None:
    """The query dispatch will use: nearest online riders by straight-line distance."""
    near, far = make.user(Role.DELIVERY), make.user(Role.DELIVERY)
    DeliveryPartner.objects.create(
        user=far, is_online=True, location=GeoPoint(lat=13.10, lng=77.70)
    )
    DeliveryPartner.objects.create(
        user=near, is_online=True, location=GeoPoint(lat=12.975, lng=77.645)
    )
    with connection.cursor() as cursor:
        cursor.execute(
            "select user_id from delivery_partners where is_online "
            "order by location <-> ST_GeogFromText('SRID=4326;POINT(77.6412 12.9719)') limit 2"
        )
        order = [row[0] for row in cursor.fetchall()]
    assert order == [near.pk, far.pk]


def test_ledger_trigger_blocks_raw_sql_edits_and_deletes() -> None:
    wallet = CoinWallet.objects.create(user=make.user())
    txn = CoinTransaction.objects.create(
        user=wallet.user,
        wallet=wallet,
        seq=1,
        type="CREDIT",
        source="ORDER_REWARD",
        coins=50,
        available_before=0,
        available_after=50,
        reserved_before=0,
        reserved_after=0,
        idempotency_key="order-reward:pg-trigger",
    )
    for sql in (
        "update coin_transactions set coins = 5000 where id = %s",
        "delete from coin_transactions where id = %s",
    ):
        with (
            pytest.raises(DatabaseError, match="LEDGER_IMMUTABLE"),
            transaction.atomic(),
            connection.cursor() as c,
        ):
            c.execute(sql, (txn.pk,))

    # The one allowed change: pending -> posted.
    with connection.cursor() as c:
        c.execute(
            "update coin_transactions set status = 'posted', posted_at = now() where id = %s",
            (txn.pk,),
        )
    txn.refresh_from_db()
    assert txn.status == "posted"
    assert txn.coins == 50

    # Once posted, even the status can't move again.
    with (
        pytest.raises(DatabaseError, match="LEDGER_IMMUTABLE"),
        transaction.atomic(),
        connection.cursor() as c,
    ):
        c.execute("update coin_transactions set status = 'pending' where id = %s", (txn.pk,))
