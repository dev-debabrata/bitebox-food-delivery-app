"""Restaurant JSON in the Node API's shape (Restaurant.toJSON with the isOpenNow virtual)."""

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from django.utils import timezone

from common.geo import GeoPoint

from .models import Restaurant


def geo_json(point: GeoPoint | None) -> dict[str, Any] | None:
    """GeoJSON as Node stored it: {type: "Point", coordinates: [lng, lat]}."""
    return None if point is None else {"type": "Point", "coordinates": [point.lng, point.lat]}


def rating_json(obj: Any) -> dict[str, Any]:
    return {
        "average": float(obj.rating_average),
        "count": obj.rating_count,
        "distribution": list(obj.rating_distribution or [0, 0, 0, 0, 0]),
    }


def _minutes(hhmm: str) -> int:
    hours, minutes = hhmm.split(":")
    return int(hours) * 60 + int(minutes)


DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _slot(s: dict[str, str]) -> tuple[int, int]:
    return _minutes(s["open"]), _minutes(s["close"])


def _open_today(opens: int, closes: int, current: int) -> bool:
    """The part of a slot that falls on its own day (an overnight slot runs to midnight)."""
    if opens == closes:
        return True  # open 24 hours
    return opens <= current < closes if opens < closes else current >= opens


def is_open_now(r: Restaurant, now: datetime | None = None) -> bool:
    """
    Open within today's hours in the restaurant's time zone. Weekly hours, when set, give each
    day its own slots; a slot that ends after midnight still counts the next morning.
    """
    if not r.is_accepting_orders:
        return False
    local = (now or timezone.now()).astimezone(ZoneInfo(r.timezone or "Asia/Kolkata"))
    current = local.hour * 60 + local.minute
    if r.weekly_hours:
        today = [_slot(s) for s in r.weekly_hours.get(DAYS[local.weekday()]) or []]
        yesterday = [_slot(s) for s in r.weekly_hours.get(DAYS[local.weekday() - 1]) or []]
    elif r.opening_time and r.closing_time:
        slot = (_minutes(r.opening_time), _minutes(r.closing_time))
        today = yesterday = [slot]
    else:
        return False
    return any(_open_today(o, c, current) for o, c in today) or any(
        c < o and current < c
        for o, c in yesterday  # last night's slot, after midnight
    )


def _compact(data: dict[str, Any]) -> dict[str, Any]:
    """Drop optional fields that are empty (MongoDB documents simply didn't have them)."""
    optional = {
        "description",
        "email",
        "image_url",
        "status_reason",
        "reviewed_at",
        "reviewed_by",
        "line2",
        "area",
        "weekly_hours",
        "fssai_number",
        "owner_name",
        "gstin",
        "fssai_valid_until",
    }
    return {k: v for k, v in data.items() if not (k in optional and v in ("", None))}


def address_json(r: Restaurant) -> dict[str, Any]:
    return _compact(
        {
            "line1": r.line1,
            "line2": r.line2,
            "area": r.area,
            "city": r.city,
            "state": r.state,
            "postal_code": r.postal_code,
        }
    )


def restaurant_json(
    r: Restaurant, *, owner: Any = "id", distance_m: float | None = None
) -> dict[str, Any]:
    """
    owner="id" (the owner's own view), "public" (no owner or review fields), or "admin"
    (owner populated with name, email, phone and status).
    """
    data: dict[str, Any] = {
        "id": str(r.pk),
        "name": r.name,
        "slug": r.slug,
        "description": r.description,
        "cuisines": list(r.cuisines or []),
        "phone": r.phone,
        "email": r.email,
        "address": address_json(r),
        "location": geo_json(r.location),
        "image_url": r.image_url,
        "is_pure_veg": r.is_pure_veg,
        "cost_for_two_paise": r.cost_for_two_paise,
        "min_order_paise": r.min_order_paise,
        "avg_prep_time_minutes": r.avg_prep_time_minutes,
        "opening_time": r.opening_time,
        "closing_time": r.closing_time,
        "timezone": r.timezone,
        "is_accepting_orders": r.is_accepting_orders,
        "is_open_now": is_open_now(r),
        "weekly_hours": r.weekly_hours,
        "photos": list(r.photos or []),
        "fssai_number": r.fssai_number,
        "status": r.status,
        "rating": rating_json(r),
        "created_at": r.created_at,
        "updated_at": r.updated_at,
    }
    if owner != "public":
        data["status_reason"] = r.status_reason
        data["reviewed_at"] = r.reviewed_at
        data["reviewed_by"] = str(r.reviewed_by_id) if r.reviewed_by_id else None
        data.update(
            owner_name=r.owner_name,
            gst_registered=r.gst_registered,
            gstin=r.gstin,
            fssai_valid_until=r.fssai_valid_until,
        )
        if owner == "admin":
            o = r.owner
            data["owner"] = {
                "id": str(o.pk),
                "name": o.name,
                "email": o.email,
                "phone": o.phone,
                "status": o.status,
            }
        else:
            data["owner"] = str(r.owner_id)
    if distance_m is not None:
        data["distance_meters"] = round(distance_m)
    return _compact(data)
