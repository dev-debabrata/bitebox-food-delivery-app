"""
Finding a rider for ready orders (Node: services/dispatch.service.js).

- Matching: the nearest free rider within `max_pickup_distance_km` of the restaurant (PostGIS,
  straight line), with a GPS fix from the last `location_fresh_minutes`, an active account, and
  no earlier offer for this order. Riders in the same 500 m band count as equally near; the one
  idle longest goes first.
- One rider is offered an order at a time. `DeliveryPartner.current_offer` and `active_order`
  are compare-and-set locks, and an order has at most one live assignment (unique index).
- `sweep(now)` expires offers, re-dispatches waiting orders and applies the timeouts. Celery Beat
  runs it every `sweep_interval_seconds`; tests call it directly.
"""

import logging
import uuid
from datetime import datetime, timedelta

from django.db import IntegrityError, transaction
from django.db.models import Exists, F, OuterRef, Q, QuerySet
from django.db.models.functions import Floor
from django.utils import timezone

from apps.accounts.models import User, UserStatus
from apps.delivery.models import DeliveryPartner
from apps.orders import presenters
from apps.orders.models import Order, OrderStatus, OrderStatusHistory, PaymentMethod
from apps.orders.notifications import notify_offer
from apps.orders.workflow import Actor, transition
from apps.realtime.events import emit_order_updated
from common.api import ApiError
from common.geo import GeoPoint
from common.geo_sql import Distance, DWithin, point_sql

from .config import DISPATCH, DISTANCE_BAND_M
from .models import AssignmentStatus, DeliveryAssignment

logger = logging.getLogger("bitebox.dispatch")

S = OrderStatus
OFFERED = AssignmentStatus.OFFERED


def free_riders(now: datetime) -> QuerySet[DeliveryPartner]:
    """Riders who could be offered an order right now (dispatch adds distance and history)."""
    return DeliveryPartner.objects.filter(
        is_online=True,
        active_order__isnull=True,
        current_offer__isnull=True,
        location__isnull=False,
        location_updated_at__gte=now - timedelta(minutes=DISPATCH["location_fresh_minutes"]),
        user__status=UserStatus.ACTIVE,
    )


def _has_open_offer() -> Exists:
    return Exists(DeliveryAssignment.objects.filter(order=OuterRef("pk"), status=OFFERED))


def waiting_orders(limit: int) -> list[Order]:
    """Ready orders nobody is being offered, longest-waiting first."""
    return list(
        Order.objects.filter(status=S.READY_FOR_PICKUP)
        .exclude(_has_open_offer())
        .order_by("updated_at")[:limit]
    )


def _pickup_point(order: Order) -> GeoPoint | None:
    location = (order.restaurant_snapshot or {}).get("location") or {}
    coordinates = location.get("coordinates")
    if not coordinates:
        return None
    return GeoPoint(lat=coordinates[1], lng=coordinates[0])


def dispatch(order_id: uuid.UUID, now: datetime | None = None) -> uuid.UUID | None:
    """Offers the order to the best free rider. Returns that rider's user id, or None."""
    now = now or timezone.now()
    order = (
        Order.objects.filter(pk=order_id, status=S.READY_FOR_PICKUP)
        .exclude(_has_open_offer())
        .first()
    )
    point = _pickup_point(order) if order else None
    if order is None or point is None:
        return None

    near = point_sql(point)
    tried = DeliveryAssignment.objects.filter(order=order).values("rider_id")
    candidates = list(
        free_riders(now)
        .exclude(user_id__in=tried)
        .filter(DWithin(F("location"), near, DISPATCH["max_pickup_distance_km"] * 1000))
        .annotate(distance=Distance(F("location"), near))
        .annotate(band=Floor(F("distance") / DISTANCE_BAND_M))
        .order_by("band", F("last_assigned_at").asc(nulls_first=True), "distance")[:10]
    )

    for candidate in candidates:
        with transaction.atomic():
            # Lock the order row: a concurrent status change (cancel, another dispatch) waits.
            if (
                not Order.objects.select_for_update()
                .filter(pk=order.pk, status=S.READY_FOR_PICKUP)
                .exists()
            ):
                return None
            locked = DeliveryPartner.objects.filter(
                pk=candidate.pk,
                is_online=True,
                active_order__isnull=True,
                current_offer__isnull=True,
            ).update(current_offer=order, updated_at=now)
            if not locked:
                continue
            try:
                with transaction.atomic():
                    DeliveryAssignment.objects.create(
                        order=order,
                        rider_id=candidate.user_id,
                        expires_at=now + timedelta(seconds=DISPATCH["offer_timeout_seconds"]),
                    )
            except IntegrityError:  # another dispatch offered this order first
                DeliveryPartner.objects.filter(pk=candidate.pk, current_offer=order).update(
                    current_offer=None
                )
                return None
            offered = presenters.reload(order)
            emit_order_updated(offered, also_notify=[candidate.user_id])
            notify_offer(offered, candidate.user_id)
        logger.info(
            "Delivery offered",
            extra={
                "order_id": str(order.pk),
                "rider": str(candidate.user_id),
                "distance_m": round(getattr(candidate, "distance", 0) or 0),
            },
        )
        return candidate.user_id
    return None


def dispatch_safely(order_id: uuid.UUID, now: datetime | None = None) -> uuid.UUID | None:
    """Dispatch without letting a failure break the caller (e.g. the restaurant's "ready")."""
    try:
        return dispatch(order_id, now)
    except Exception:
        logger.exception("Dispatch failed; the sweep will retry", extra={"order": str(order_id)})
        return None


def _offer_gone() -> ApiError:
    return ApiError(409, "This delivery request is no longer available", code="OFFER_UNAVAILABLE")


def accept_offer(user: User, order_id: uuid.UUID) -> Order:
    """The rider accepts their current offer: the order becomes "assigned" to them."""
    now = timezone.now()
    live_offer = Exists(
        DeliveryAssignment.objects.filter(
            order=OuterRef("pk"), rider=user, status=OFFERED, expires_at__gt=now
        )
    )

    def take(order: Order) -> None:
        DeliveryAssignment.objects.filter(order=order, rider=user, status=OFFERED).update(
            status=AssignmentStatus.ACCEPTED, responded_at=now, updated_at=now
        )
        DeliveryPartner.objects.filter(user=user, current_offer=order).update(
            current_offer=None, active_order=order, last_assigned_at=now, updated_at=now
        )

    try:
        result = transition(
            order_id,
            to=S.ASSIGNED,
            actor=Actor.DELIVERY,
            user=user,
            where=Q(live_offer),
            update={"delivery_partner": user},
            on_change=take,
        )
    except ApiError as error:
        if error.status_code == 409:
            raise _offer_gone() from None
        raise
    if not result.changed and result.order.delivery_partner_id != user.pk:
        raise _offer_gone()
    return result.order


def decline_offer(user_id: uuid.UUID, order_id: uuid.UUID) -> None:
    now = timezone.now()
    with transaction.atomic():
        declined = DeliveryAssignment.objects.filter(
            order_id=order_id,
            rider_id=user_id,
            status=OFFERED,
            order__status=S.READY_FOR_PICKUP,
        ).update(status=AssignmentStatus.DECLINED, responded_at=now, updated_at=now)
        if not declined:
            raise _offer_gone()
        DeliveryPartner.objects.filter(user_id=user_id, current_offer_id=order_id).update(
            current_offer=None, updated_at=now
        )
    if not dispatch_safely(order_id):
        order = Order.objects.filter(pk=order_id).first()
        if order:
            emit_order_updated(order, also_notify=[user_id])


def _minutes_ago(now: datetime, minutes: float) -> datetime:
    return now - timedelta(minutes=minutes)


def sweep(now: datetime | None = None) -> dict[str, int]:
    now = now or timezone.now()
    summary = {
        "expired_offers": 0,
        "dispatched": 0,
        "auto_rejected": 0,
        "unpaid_cancelled": 0,
        "pickup_expired": 0,
    }

    # 1. Offers nobody answered: the rider goes offline (they are probably not looking).
    expired = DeliveryAssignment.objects.filter(
        status=OFFERED, expires_at__lte=now, order__status=S.READY_FOR_PICKUP
    ).select_related("order")[:100]
    for offer in expired:
        with transaction.atomic():
            cleared = DeliveryAssignment.objects.filter(pk=offer.pk, status=OFFERED).update(
                status=AssignmentStatus.EXPIRED, responded_at=now, updated_at=now
            )
            if not cleared:
                continue
            DeliveryPartner.objects.filter(
                user_id=offer.rider_id, current_offer_id=offer.order_id
            ).update(current_offer=None, is_online=False, updated_at=now)
            summary["expired_offers"] += 1
            emit_order_updated(offer.order, also_notify=[offer.rider_id])

    # 2. Waiting orders get another try while any rider is free.
    if free_riders(now).exists():
        for order in waiting_orders(50):
            if dispatch_safely(order.pk, now):
                summary["dispatched"] += 1

    # 3. Timeouts.
    ready_too_long = Exists(
        OrderStatusHistory.objects.filter(
            order=OuterRef("pk"),
            to_status=S.READY_FOR_PICKUP,
            created_at__lte=_minutes_ago(now, DISPATCH["pickup_window_minutes"]),
        )
    )
    timeouts: list[tuple[QuerySet[Order], str, str, str, Q | None]] = [
        (
            Order.objects.filter(
                status=S.PENDING,
                submitted_at__isnull=False,
                submitted_at__lte=_minutes_ago(now, DISPATCH["restaurant_response_minutes"]),
            ),
            S.REJECTED,
            "The restaurant did not respond in time",
            "auto_rejected",
            None,
        ),
        (
            Order.objects.filter(
                status=S.PENDING,
                payment_method=PaymentMethod.ONLINE,
                submitted_at__isnull=True,
                created_at__lte=_minutes_ago(now, DISPATCH["payment_window_minutes"]),
            ),
            S.CANCELLED,
            "Payment was not completed in time",
            "unpaid_cancelled",
            Q(submitted_at__isnull=True),  # lost the race to a payment: leave the paid order
        ),
        (
            Order.objects.filter(
                status__in=[S.READY_FOR_PICKUP, S.ASSIGNED, S.ARRIVED_AT_RESTAURANT]
            ).filter(ready_too_long),
            S.CANCELLED,
            "No delivery partner picked up the order in time",
            "pickup_expired",
            None,
        ),
    ]
    for qs, to, reason, key, where in timeouts:
        for order_id in list(qs.values_list("pk", flat=True)[:100]):
            try:
                result = transition(order_id, to=to, actor=Actor.SYSTEM, reason=reason, where=where)
            except ApiError:
                continue
            if result.changed:
                summary[key] += 1
    return summary
