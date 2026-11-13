"""
Rider tracking points and the REST view of a delivery's position
(GET /tracking/orders/{id}: lets the map restore its state after reconnecting).
"""

import uuid
from datetime import datetime, timedelta
from typing import Any

from django.conf import settings
from django.utils import timezone

from apps.accounts.models import User
from apps.delivery.models import DeliveryPartner
from apps.orders.models import TRACKED_STATUSES, Order
from apps.rbac.roles import Permission, Role, has_permission
from common.api import ApiError
from common.geo import GeoPoint

from .models import TrackingPoint

PATH_LIMIT = 200  # the newest points of a delivery sent to the map


def record(
    rider_id: Any,
    order_id: Any,
    latitude: float,
    longitude: float,
    accuracy: float | None,
    at: datetime,
) -> bool:
    """Stores a fix for the delivery unless this rider stored one within the sample interval."""
    recent = at - timedelta(seconds=settings.TRACKING_SAMPLE_SECONDS)
    if TrackingPoint.objects.filter(rider_id=rider_id, recorded_at__gt=recent).exists():
        return False
    TrackingPoint.objects.create(
        rider_id=rider_id,
        order_id=order_id,
        location=GeoPoint(lat=latitude, lng=longitude),
        accuracy_m=accuracy,
        recorded_at=at,
    )
    return True


def on_position(
    rider_id: Any,
    order_id: Any,
    latitude: float,
    longitude: float,
    accuracy: float | None,
    at: datetime,
) -> None:
    """A fix of a rider carrying an order: store it (sampled) and tell the customer when close."""
    record(rider_id, order_id, latitude, longitude, accuracy, at)
    notify_if_approaching(order_id, latitude, longitude, at)


def notify_if_approaching(order_id: Any, latitude: float, longitude: float, at: datetime) -> bool:
    """Once per order: the rider on the way is within APPROACH_NOTIFY_METERS of the customer."""
    from apps.orders.models import OrderStatus
    from apps.orders.notifications import notify_approaching
    from common.geo import haversine_m

    order = Order.objects.filter(
        pk=order_id, status=OrderStatus.ON_THE_WAY, approach_notified_at__isnull=True
    ).first()
    if order is None or order.delivery_location is None:
        return False
    if haversine_m(GeoPoint(lat=latitude, lng=longitude), order.delivery_location) > (
        settings.APPROACH_NOTIFY_METERS
    ):
        return False
    claimed = Order.objects.filter(pk=order.pk, approach_notified_at__isnull=True).update(
        approach_notified_at=at
    )
    if claimed:
        notify_approaching(order)
    return bool(claimed)


def tracked_order_id(rider_id: Any) -> uuid.UUID | None:
    """The order this rider is carrying in a tracked status (assigned → on the way), if any."""
    return (
        Order.objects.filter(delivery_partner_id=rider_id, status__in=TRACKED_STATUSES)
        .values_list("pk", flat=True)
        .first()
    )


def _can_view(user: User, order: Order) -> bool:
    if has_permission(user.role, Permission.ORDERS_VIEW):
        return True
    if user.role == Role.CUSTOMER:
        return order.customer_id == user.pk
    if user.role == Role.DELIVERY:
        return order.delivery_partner_id == user.pk
    return False


def order_tracking(user: User, order_id: uuid.UUID, now: datetime | None = None) -> dict[str, Any]:
    """The rider's last position (and whether it is stale) plus the delivery's recent path."""
    order = Order.objects.filter(pk=order_id).first()
    if order is None or not _can_view(user, order):
        raise ApiError.not_found("Order not found")
    now = now or timezone.now()
    rider_id = order.delivery_partner_id
    tracking = order.status in TRACKED_STATUSES and rider_id is not None
    last_point = None
    age = None
    path: list[list[float]] = []
    if tracking and rider_id is not None:
        profile = DeliveryPartner.objects.filter(user_id=rider_id).first()
        if profile and profile.location and profile.location_updated_at:
            age = max(0, int((now - profile.location_updated_at).total_seconds()))
            last_point = {
                "latitude": profile.location.lat,
                "longitude": profile.location.lng,
                "accuracy": profile.location_accuracy_m,
                "at": profile.location_updated_at,
            }
        newest = TrackingPoint.objects.filter(order=order).order_by("-recorded_at")[:PATH_LIMIT]
        path = [[p.location.lat, p.location.lng] for p in reversed(list(newest))]
    return {
        "order_id": str(order.pk),
        "status": order.status,
        "tracking": tracking,
        "last_point": last_point,
        "age_seconds": age,
        "stale": age is not None and age > settings.TRACKING_STALE_SECONDS,
        "recent_path": path,
    }


def purge(now: datetime | None = None) -> int:
    """Deletes points older than the retention period. Returns how many."""
    cutoff = (now or timezone.now()) - timedelta(days=settings.TRACKING_RETENTION_DAYS)
    deleted, _ = TrackingPoint.objects.filter(recorded_at__lt=cutoff).delete()
    return deleted
