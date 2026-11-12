"""
Points without GDAL. The column is a PostGIS `geography(Point, 4326)` on PostgreSQL, so distance
and nearest-neighbour queries run in the database (ST_DWithin, ST_Distance, `<->`) with a GiST
index. In Python a value is a `GeoPoint(lat, lng)`.

Why not GeoDjango: it needs the GDAL and GEOS C libraries just to import, which keeps the models
from loading on machines (and CI steps) without them. A point column needs none of that; the
database does the geometry. On SQLite (local tests only) the same value is stored as EWKT text
and spatial queries are unavailable.

Distances keep their labels (docs/DOCUMENTATION.md): straight-line (this module, fees, dispatch),
road estimate (routing), live GPS.
"""

import math
import re
import struct
from dataclasses import dataclass
from typing import Any

from django.core.exceptions import ValidationError
from django.db import models
from django.db.backends.base.base import BaseDatabaseWrapper

SRID = 4326
EARTH_RADIUS_M = 6_371_000  # same as the Node API (utils/geo.js)
_EWKT = re.compile(r"^(?:SRID=4326;)?POINT\(\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s*\)$")


@dataclass(frozen=True)
class GeoPoint:
    lat: float
    lng: float

    def __post_init__(self) -> None:
        if not (-90 <= self.lat <= 90 and -180 <= self.lng <= 180) or math.isnan(
            self.lat + self.lng
        ):
            raise ValidationError("Invalid coordinates", code="invalid_point")

    @property
    def ewkt(self) -> str:
        # WKT order is longitude first.
        return f"SRID={SRID};POINT({self.lng!r} {self.lat!r})"

    def as_dict(self) -> dict[str, float]:
        return {"lat": self.lat, "lng": self.lng}


def parse_point(value: str | bytes | memoryview) -> GeoPoint:
    """EWKT text, or the hex/binary EWKB PostGIS returns for a geography point."""
    if isinstance(value, str):
        match = _EWKT.match(value.strip())
        if match:
            return GeoPoint(lat=float(match.group(2)), lng=float(match.group(1)))
        raw = bytes.fromhex(value)
    else:
        raw = bytes(value)
    order = "<" if raw[0] == 1 else ">"
    (geom_type,) = struct.unpack(f"{order}I", raw[1:5])
    offset = 5
    if geom_type & 0x20000000:  # has SRID
        offset += 4
    if geom_type & 0xFF != 1:
        raise ValueError("not a point")
    lng, lat = struct.unpack(f"{order}dd", raw[offset : offset + 16])
    return GeoPoint(lat=lat, lng=lng)


def haversine_m(a: GeoPoint, b: GeoPoint) -> int:
    """Straight-line distance in whole metres (same formula and rounding as utils/geo.js)."""
    p1, p2 = math.radians(a.lat), math.radians(b.lat)
    dp, dl = p2 - p1, math.radians(b.lng - a.lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return round(2 * EARTH_RADIUS_M * math.asin(math.sqrt(h)))


class PointField(models.Field):
    description = "A WGS84 point (PostGIS geography on PostgreSQL)"

    def db_type(self, connection: BaseDatabaseWrapper) -> str:
        if connection.vendor == "postgresql":
            return f"geography(Point,{SRID})"
        return "text"

    def from_db_value(
        self, value: Any, expression: Any, connection: BaseDatabaseWrapper
    ) -> GeoPoint | None:
        return None if value is None else parse_point(value)

    def to_python(self, value: Any) -> GeoPoint | None:
        if value is None or isinstance(value, GeoPoint):
            return value
        if isinstance(value, dict):
            return GeoPoint(lat=float(value["lat"]), lng=float(value["lng"]))
        if isinstance(value, (tuple, list)) and len(value) == 2:
            # GeoJSON order, as stored by the Node API: [lng, lat]
            return GeoPoint(lat=float(value[1]), lng=float(value[0]))
        return parse_point(value)

    def get_prep_value(self, value: Any) -> str | None:
        point = self.to_python(value)
        return None if point is None else point.ewkt

    def value_to_string(self, obj: Any) -> str:
        point = self.value_from_object(obj)
        return "" if point is None else point.ewkt
