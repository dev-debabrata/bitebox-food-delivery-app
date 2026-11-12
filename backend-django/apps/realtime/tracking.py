"""
Live tracking over the socket (Node: sockets/index.js and sockets/tracking.js).

The consumer calls these synchronous functions through `database_sync_to_async`:
- `initial_groups(user)`: rooms come only from the server-side identity.
- `join(user, order_id)`: `track:join` after a database permission check.
- `rider_state(user)` and `persist_location(...)`: the rider's position reports.
`RiderLimiter` holds the per-socket checks (token bucket, accuracy, implausible speed).
"""

import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from django.utils import timezone

from apps.accounts.models import User
from apps.delivery.models import DeliveryPartner
from apps.orders.models import TRACKED_STATUSES, Order, OrderStatus
from apps.rbac.roles import Permission, Role, has_permission
from apps.restaurants.models import Restaurant
from common.geo import GeoPoint, haversine_m

from .events import ADMINS, order_group, restaurant_group, user_group

LIMITS = {
    "max_accuracy_m": 1000,  # fixes less precise than this are dropped
    "max_speed_mps": 70,  # ~250 km/h: anything faster is a GPS jump or spoofing
    "burst": 5,
    "refill_per_second": 1,
    "persist_every_seconds": 5,  # the database keeps at most one fix per 5 s per rider
    "recheck_every_seconds": 5,  # how often the rider's online/active-order state is re-read
}


def initial_groups(user: User) -> list[str]:
    groups = [user_group(user.pk)]
    if has_permission(user.role, Permission.ORDERS_VIEW):
        groups.append(ADMINS)
    if user.role == Role.RESTAURANT:
        restaurant_id = Restaurant.objects.filter(owner=user).values_list("pk", flat=True).first()
        if restaurant_id:
            groups.append(restaurant_group(restaurant_id))
    return groups


def _can_track(user: User, order: Order) -> bool:
    if has_permission(user.role, Permission.ORDERS_VIEW):
        return True
    if user.role == Role.CUSTOMER:
        return order.customer_id == user.pk
    if user.role == Role.DELIVERY:
        return order.delivery_partner_id == user.pk
    if user.role == Role.RESTAURANT:
        return Restaurant.objects.filter(pk=order.restaurant_id, owner=user).exists()
    return False


def _iso(value: datetime | None) -> str | None:
    return value.isoformat().replace("+00:00", "Z") if value else None


def location_payload(order_id: Any, profile: DeliveryPartner) -> dict[str, Any] | None:
    if profile.location is None:
        return None
    return {
        "orderId": str(order_id),
        "latitude": profile.location.lat,
        "longitude": profile.location.lng,
        "accuracy": profile.location_accuracy_m,
        "at": _iso(profile.location_updated_at),
    }


def join(user: User, order_id: Any) -> tuple[dict[str, Any], str | None]:
    """The ack for `track:join`, and the group to join (None: do not join)."""
    try:
        oid = uuid.UUID(str(order_id))
    except (TypeError, ValueError):
        return {"ok": False, "error": "INVALID_ORDER"}, None
    order = Order.objects.filter(pk=oid).first()
    if order is None or not _can_track(user, order):
        return {"ok": False, "error": "NOT_FOUND"}, None
    if order.status not in TRACKED_STATUSES and order.status != OrderStatus.READY_FOR_PICKUP:
        return {"ok": True, "location": None, "tracking": False}, None
    location = None
    if order.status in TRACKED_STATUSES and order.delivery_partner_id:
        profile = DeliveryPartner.objects.filter(user_id=order.delivery_partner_id).first()
        if profile:
            location = location_payload(order.pk, profile)
    return {"ok": True, "location": location, "tracking": True}, order_group(order.pk)


def rider_state(user: User) -> dict[str, Any]:
    online = DeliveryPartner.objects.filter(user=user, is_online=True).exists()
    tracked = (
        Order.objects.filter(delivery_partner=user, status__in=TRACKED_STATUSES)
        .values_list("pk", flat=True)
        .first()
    )
    return {"online": online, "tracked_order_id": str(tracked) if tracked else None}


def persist_location(
    user: User, latitude: float, longitude: float, accuracy: float | None, at: datetime
) -> None:
    fields: dict[str, Any] = {
        "location": GeoPoint(lat=latitude, lng=longitude),
        "location_updated_at": at,
        "updated_at": timezone.now(),
    }
    if accuracy is not None:
        fields["location_accuracy_m"] = accuracy
    DeliveryPartner.objects.filter(user=user).update(**fields)


def parse_fix(body: Any) -> tuple[float, float, float | None] | None:
    """(latitude, longitude, accuracy) from a `rider:location` body, or None when invalid."""
    if not isinstance(body, dict):
        return None
    try:
        latitude = float(body.get("latitude"))  # type: ignore[arg-type]
        longitude = float(body.get("longitude"))  # type: ignore[arg-type]
        raw = body.get("accuracy")
        accuracy = None if raw is None else float(raw)
    except (TypeError, ValueError):
        return None
    finite = all(abs(v) != float("inf") and v == v for v in (latitude, longitude))
    if not finite or not (-90 <= latitude <= 90) or not (-180 <= longitude <= 180):
        return None
    if accuracy is not None and (accuracy != accuracy or accuracy < 0):
        return None
    return latitude, longitude, accuracy


@dataclass
class RiderLimiter:
    """Per-socket state for `rider:location`."""

    tokens: float = LIMITS["burst"]
    refilled_at: float = field(default_factory=time.monotonic)
    last: tuple[float, float, float] | None = None  # latitude, longitude, monotonic time
    persisted_at: float = float("-inf")
    state: dict[str, Any] | None = None
    checked_at: float = float("-inf")

    def take(self, now: float) -> bool:
        self.tokens = min(
            LIMITS["burst"], self.tokens + (now - self.refilled_at) * LIMITS["refill_per_second"]
        )
        self.refilled_at = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True

    def check(
        self, latitude: float, longitude: float, accuracy: float | None, now: float
    ) -> str | None:
        """An error code, or None when the fix is acceptable (and becomes the last one)."""
        if accuracy is not None and accuracy > LIMITS["max_accuracy_m"]:
            return "IMPRECISE"
        if self.last:
            seconds = max(1.0, now - self.last[2])
            metres = haversine_m(
                GeoPoint(lat=self.last[0], lng=self.last[1]), GeoPoint(lat=latitude, lng=longitude)
            )
            if metres / seconds > LIMITS["max_speed_mps"]:
                return "IMPLAUSIBLE"
        self.last = (latitude, longitude, now)
        return None

    def should_recheck(self, now: float) -> bool:
        return self.state is None or now - self.checked_at >= LIMITS["recheck_every_seconds"]

    def should_persist(self, now: float) -> bool:
        if now - self.persisted_at >= LIMITS["persist_every_seconds"]:
            self.persisted_at = now
            return True
        return False
