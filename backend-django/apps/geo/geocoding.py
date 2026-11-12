"""
Place search and reverse geocoding (Node: services/geocoding.service.js): Nominatim first, then
the Photon and BigDataCloud fallbacks. Both fail soft: the UI lets people pin the map instead.
"""

import logging
from typing import Any

from django.conf import settings

from common.api import ApiError

from . import upstream

logger = logging.getLogger("bitebox.geo")
DAY = 24 * 60 * 60


def _unique(*values: Any) -> list[str]:
    out: list[str] = []
    for v in values:
        if v and v not in out:
            out.append(v)
    return out


def make_place(
    *,
    label: str | None,
    display_name: str | None,
    latitude: Any,
    longitude: Any,
    area: str | None = None,
    city: str | None = None,
    state: str | None = None,
    postal_code: str | None = None,
    street: str | None = None,
    building: str | None = None,
) -> dict[str, Any]:
    place: dict[str, Any] = {
        "label": label or "Pinned location",
        "display_name": display_name or label or "Pinned location",
        "latitude": float(latitude),
        "longitude": float(longitude),
        "area": area or None,
        "city": city or None,
        "state": state or None,
        "postal_code": postal_code or None,
    }
    if street:
        place["street"] = street
    if building:
        place["building"] = building
    return place


def _first(a: dict[str, Any], *keys: str) -> Any:
    return next((a[k] for k in keys if a.get(k)), None)


def nominatim_place(item: dict[str, Any]) -> dict[str, Any]:
    a = item.get("address") or {}
    street = _first(a, "road", "pedestrian", "street", "residential", "footway", "path")
    building = _first(
        a, "building", "house_number", "house_name", "commercial", "industrial", "amenity"
    )
    suburb = _first(a, "suburb", "neighbourhood", "quarter", "district", "village", "hamlet")
    area = suburb or street or a.get("subdivision")
    city = _first(a, "city", "town", "municipality", "city_district", "county", "state_district")
    display = item.get("display_name") or ""
    label = (
        ", ".join(_unique(area, city))
        or ",".join(display.split(",")[:2]).strip()
        or item.get("name")
    )
    return make_place(
        label=label,
        display_name=item.get("display_name"),
        latitude=item["lat"],
        longitude=item["lon"],
        area=area,
        city=city,
        state=a.get("state"),
        postal_code=a.get("postcode"),
        street=street,
        building=building,
    )


def photon_place(feature: dict[str, Any]) -> dict[str, Any]:
    p = feature.get("properties") or {}
    lon, lat = (feature.get("geometry") or {}).get("coordinates") or [0, 0]
    area = _first(p, "district", "suburb", "locality", "neighbourhood", "street", "name")
    city = _first(p, "city", "town", "county")
    return make_place(
        label=", ".join(_unique(area, city)) or p.get("name"),
        display_name=", ".join(
            _unique(
                p.get("name"),
                p.get("street"),
                area,
                city,
                p.get("state"),
                p.get("postcode"),
                p.get("country"),
            )
        ),
        latitude=lat,
        longitude=lon,
        area=area,
        city=city,
        state=p.get("state"),
        postal_code=p.get("postcode"),
        street=p.get("street"),
        building=p.get("housenumber") or p.get("name"),
    )


def bigdatacloud_place(d: dict[str, Any], latitude: float, longitude: float) -> dict[str, Any]:
    admin = ((d.get("localityInfo") or {}).get("administrative")) or []
    area = d.get("locality") or next(
        (x.get("name") for x in admin if (x.get("order") or 0) >= 6), None
    )
    city = d.get("city") or d.get("principalSubdivision")
    return make_place(
        label=", ".join(_unique(area, city)),
        display_name=", ".join(
            v for v in (area, city, d.get("principalSubdivision"), d.get("countryName")) if v
        ),
        latitude=latitude,
        longitude=longitude,
        area=area,
        city=city,
        state=d.get("principalSubdivision"),
        postal_code=d.get("postcode"),
    )


def _nominatim(path: str, params: dict[str, Any]) -> Any:
    return upstream.fetch_json(
        f"{settings.GEOCODER_URL.rstrip('/')}{path}",
        {"format": "jsonv2", "addressdetails": 1, **params},
        {"User-Agent": settings.GEOCODER_USER_AGENT, "Accept-Language": "en"},
    )


def _photon_search(q: str) -> list[dict[str, Any]]:
    data = upstream.fetch_json(
        "https://photon.komoot.io/api/", {"q": q, "limit": 6}, {"Accept-Language": "en"}
    )
    return [photon_place(f) for f in (data.get("features") or [])]


def search(query: str) -> list[dict[str, Any]]:
    q = query.strip()

    def load() -> list[dict[str, Any]]:
        try:
            places = [
                nominatim_place(i)
                for i in _nominatim(
                    "/search", {"q": q, "limit": 6, "countrycodes": settings.GEOCODER_COUNTRY_CODES}
                )
            ]
            if places:
                return places
            try:
                return _photon_search(q) or places
            except Exception:
                return places
        except Exception:
            logger.warning("Nominatim search failed, trying the fallback", extra={"query": q})
            try:
                return _photon_search(q)
            except Exception:
                logger.warning("Location search failed completely", extra={"query": q})
                raise ApiError(
                    503,
                    "Location search is unavailable right now. Please try again.",
                    code="GEOCODER_UNAVAILABLE",
                ) from None

    return list(upstream.cached("geocoder", f"s:{q.lower()}", DAY, load))


def reverse(latitude: float, longitude: float) -> dict[str, Any]:
    def load() -> dict[str, Any]:
        try:
            result = _nominatim("/reverse", {"lat": latitude, "lon": longitude, "zoom": 16})
            if not result or result.get("error"):
                raise LookupError("Nominatim could not reverse geocode")
            return {**nominatim_place(result), "latitude": latitude, "longitude": longitude}
        except Exception:
            logger.warning("Nominatim reverse failed, trying the fallbacks")
            try:
                return _fallback_reverse(latitude, longitude)
            except Exception:
                raise ApiError.not_found("No address found for this location") from None

    return dict(upstream.cached("geocoder", f"r:{latitude:.3f},{longitude:.3f}", DAY, load))


def _fallback_reverse(latitude: float, longitude: float) -> dict[str, Any]:
    try:
        data = upstream.fetch_json(
            "https://photon.komoot.io/reverse",
            {"lat": latitude, "lon": longitude},
            {"Accept-Language": "en"},
        )
        if features := data.get("features"):
            return {**photon_place(features[0]), "latitude": latitude, "longitude": longitude}
    except Exception:
        logger.debug("Photon reverse failed, trying BigDataCloud")
    data = upstream.fetch_json(
        "https://api.bigdatacloud.net/data/reverse-geocode-client",
        {"latitude": latitude, "longitude": longitude, "localityLanguage": "en"},
    )
    return bigdatacloud_place(data, latitude, longitude)
