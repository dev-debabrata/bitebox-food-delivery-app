"""
Road routes (Node: services/routing.service.js): OSRM behind a swappable provider. Results are
labelled as estimates; distances stay labelled straight-line vs road (docs/DOCUMENTATION.md).
"""

import contextlib
import logging
from collections.abc import Iterator
from typing import Any, Protocol

from django.conf import settings

from common.api import ApiError
from common.geo import GeoPoint, haversine_m

from . import upstream

logger = logging.getLogger("bitebox.geo")
MAX_ROUTE_KM = 100  # deliveries are local; anything longer is a bad request
TTL_SECONDS = 10 * 60


class RouteProvider(Protocol):
    name: str
    attribution: str

    def route(self, start: GeoPoint, end: GeoPoint) -> dict[str, Any]: ...


class Osrm:
    name = "osrm"
    attribution = "Routes © OSRM, map data © OpenStreetMap contributors"

    def route(self, start: GeoPoint, end: GeoPoint) -> dict[str, Any]:
        coords = f"{start.lng},{start.lat};{end.lng},{end.lat}"
        body = upstream.fetch_json(
            f"{settings.ROUTING_URL.rstrip('/')}/route/v1/{settings.ROUTING_PROFILE}/{coords}",
            {
                "overview": "simplified",
                "geometries": "geojson",
                "alternatives": "false",
                "steps": "false",
            },
            {"User-Agent": settings.GEOCODER_USER_AGENT},
            timeout=6,
        )
        best = (body.get("routes") or [None])[0]
        if body.get("code") != "Ok" or not best:
            raise LookupError(f"Routing returned {body.get('code') or 'no route'}")
        return {
            "distance_meters": round(best["distance"]),
            "duration_seconds": round(best["duration"]),
            "path": [
                {"latitude": lat, "longitude": lng} for lng, lat in best["geometry"]["coordinates"]
            ],
        }


_provider: RouteProvider = Osrm()


@contextlib.contextmanager
def use_provider(provider: RouteProvider) -> Iterator[None]:
    """Swap the routing provider (tests)."""
    global _provider
    previous, _provider = _provider, provider
    try:
        yield
    finally:
        _provider = previous


def _key(p: GeoPoint) -> str:
    return f"{p.lat:.4f},{p.lng:.4f}"


def route(start: GeoPoint, end: GeoPoint) -> dict[str, Any]:
    straight = haversine_m(start, end)
    if straight > MAX_ROUTE_KM * 1000:
        raise ApiError.bad_request(f"Routes are limited to {MAX_ROUTE_KM} km")
    provider = _provider

    def load() -> dict[str, Any]:
        return {
            **provider.route(start, end),
            "straight_line_meters": straight,
            "provider": provider.name,
            "attribution": provider.attribution,
            "estimate": True,
        }

    try:
        return dict(
            upstream.cached(
                f"routing-{provider.name}", f"{_key(start)}|{_key(end)}", TTL_SECONDS, load
            )
        )
    except ApiError:
        raise
    except Exception:
        logger.warning("Routing request failed", exc_info=True)
        raise ApiError(
            503, "Road routing is unavailable right now", code="ROUTING_UNAVAILABLE"
        ) from None
