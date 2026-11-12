"""
PostGIS expressions for querysets (PostgreSQL only). Points are `geography(Point,4326)`, so
distances are metres on the spheroid, and `.filter(DWithin(...))` uses the GiST index.

    near = point_sql(GeoPoint(lat=12.97, lng=77.59))
    Restaurant.objects.filter(DWithin(F("location"), near, 10_000)).annotate(
        d=Distance(F("location"), near)
    )
"""

from typing import Any

from django.db.models import BooleanField, F, FloatField, Func, Value
from django.db.models.fields import TextField

from .geo import GeoPoint


class GeogFromText(Func):
    function = "ST_GeogFromText"
    output_field = TextField()  # a geography; only ever passed to other PostGIS functions


def point_sql(point: GeoPoint) -> GeogFromText:
    return GeogFromText(Value(point.ewkt))


class Distance(Func):
    """Straight-line metres between two geographies."""

    function = "ST_Distance"
    output_field = FloatField()


class DWithin(Func):
    """True when two geographies are within `metres`; usable directly in .filter()."""

    function = "ST_DWithin"
    output_field = BooleanField()
    conditional = True

    def __init__(self, a: Any, b: Any, metres: float, **extra: Any) -> None:
        super().__init__(a, b, Value(float(metres)), **extra)


__all__ = ["DWithin", "Distance", "F", "GeogFromText", "point_sql"]
