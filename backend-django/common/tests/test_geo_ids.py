import struct
import time

import pytest
from django.core.exceptions import ValidationError

from common.geo import GeoPoint, PointField, haversine_m, parse_point
from common.ids import uuid7


def test_uuid7_is_version_7_and_time_ordered() -> None:
    first = uuid7()
    time.sleep(0.002)
    second = uuid7()
    assert first.version == 7
    assert first.variant == "specified in RFC 4122"
    assert first < second


def test_points_round_trip_as_ewkt_lng_first() -> None:
    point = GeoPoint(lat=12.9719, lng=77.6412)
    assert point.ewkt == "SRID=4326;POINT(77.6412 12.9719)"
    assert parse_point(point.ewkt) == point


def test_parses_the_hex_ewkb_postgis_returns() -> None:
    # Little-endian EWKB point with SRID, as PostGIS sends a geography(Point,4326) value.
    raw = struct.pack("<BII", 1, 0x20000001, 4326) + struct.pack("<dd", 77.6412, 12.9719)
    assert parse_point(raw.hex().upper()) == GeoPoint(lat=12.9719, lng=77.6412)
    assert parse_point(memoryview(raw)) == GeoPoint(lat=12.9719, lng=77.6412)


def test_field_accepts_dicts_and_geojson_order() -> None:
    field = PointField()
    assert field.to_python({"lat": 1, "lng": 2}) == GeoPoint(lat=1, lng=2)
    assert field.to_python([77.6, 12.9]) == GeoPoint(lat=12.9, lng=77.6)  # Node stored [lng, lat]


@pytest.mark.parametrize(("lat", "lng"), [(91, 0), (0, 181), (float("nan"), 0)])
def test_rejects_impossible_coordinates(lat: float, lng: float) -> None:
    with pytest.raises(ValidationError):
        GeoPoint(lat=lat, lng=lng)


def test_haversine_matches_the_seed_distance() -> None:
    restaurant = GeoPoint(lat=12.9719, lng=77.6412)
    customer = GeoPoint(lat=12.9352, lng=77.6271)
    assert 4_200 < haversine_m(restaurant, customer) < 4_500  # "about 4 km" in the seed
