"""
The order state machine (Node: services/order-workflow.service.js). This is the only place an
order's status changes.

- `TRANSITIONS[from][to]` lists the actors allowed to make a move.
- `transition()` is a conditional update ("still in status X"). The loser of a race gets
  409 ORDER_CHANGED, and repeating the same move is a no-op (`changed=False`).
- Side effects (coupon release, payment settlement, freeing the rider, the settlement split) are
  idempotent and run in their own savepoints: a failing one is logged and never undoes the move.
- Notifications and the realtime event go out after the commit.
"""

import logging
import secrets
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from django.conf import settings
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from apps.coupons.models import Coupon, CouponRedemption
from apps.delivery.models import DeliveryPartner
from apps.dispatch.models import LIVE_STATUSES, AssignmentStatus, DeliveryAssignment
from apps.finance.earnings import settlement_for
from apps.finance.models import OrderSettlement
from apps.payments.models import Payment
from apps.realtime.events import emit_order_updated
from common.api import ApiError

from . import presenters
from .models import (
    ACTIVE_STATUSES,
    FINAL_STATUSES,
    Order,
    OrderCancellation,
    OrderStatus,
    OrderStatusHistory,
    PaymentMethod,
    PaymentStatus,
)
from .notifications import notify_status_change

logger = logging.getLogger("bitebox.orders")

S = OrderStatus


class Actor(StrEnum):
    """Who may move an order: the three panels, plus "system" for automatic timeouts."""

    CUSTOMER = "customer"
    RESTAURANT = "restaurant"
    DELIVERY = "delivery"
    ADMIN = "admin"
    SYSTEM = "system"


A = Actor

TRANSITIONS: dict[str, dict[str, tuple[Actor, ...]]] = {
    S.PENDING: {
        S.CONFIRMED: (A.RESTAURANT,),
        S.REJECTED: (A.RESTAURANT, A.SYSTEM),
        S.CANCELLED: (A.CUSTOMER, A.ADMIN, A.SYSTEM),
    },
    S.CONFIRMED: {S.PREPARING: (A.RESTAURANT,), S.CANCELLED: (A.ADMIN,)},
    S.PREPARING: {S.READY_FOR_PICKUP: (A.RESTAURANT,), S.CANCELLED: (A.ADMIN,)},
    # A rider accepts an offer, or an admin assigns one directly (manual assignment).
    S.READY_FOR_PICKUP: {S.ASSIGNED: (A.DELIVERY, A.ADMIN), S.CANCELLED: (A.ADMIN, A.SYSTEM)},
    S.ASSIGNED: {
        S.ARRIVED_AT_RESTAURANT: (A.DELIVERY,),
        # Arrival is optional: riders' apps without that step go straight to "picked up".
        S.PICKED_UP: (A.DELIVERY,),
        S.READY_FOR_PICKUP: (A.ADMIN,),
        S.CANCELLED: (A.ADMIN, A.SYSTEM),
    },
    S.ARRIVED_AT_RESTAURANT: {
        S.PICKED_UP: (A.DELIVERY,),
        S.READY_FOR_PICKUP: (A.ADMIN,),
        S.CANCELLED: (A.ADMIN, A.SYSTEM),
    },
    S.PICKED_UP: {S.ON_THE_WAY: (A.DELIVERY,)},
    S.ON_THE_WAY: {S.DELIVERED: (A.DELIVERY,)},
    S.DELIVERED: {},
    S.REJECTED: {},
    S.CANCELLED: {},
}

LABEL: dict[str, str] = {
    S.PENDING: "waiting for the restaurant",
    S.CONFIRMED: "confirmed",
    S.REJECTED: "rejected",
    S.PREPARING: "being prepared",
    S.READY_FOR_PICKUP: "ready for pickup",
    S.ASSIGNED: "assigned to a rider",
    S.ARRIVED_AT_RESTAURANT: "with the rider at the restaurant",
    S.PICKED_UP: "picked up",
    S.ON_THE_WAY: "on the way",
    S.DELIVERED: "delivered",
    S.CANCELLED: "cancelled",
}

__all__ = ["ACTIVE_STATUSES", "FINAL_STATUSES", "TRANSITIONS", "Actor", "transition"]


def new_delivery_otp() -> str:
    """Four random digits (leading zeros kept)."""
    return f"{secrets.randbelow(10_000):04d}"


def can_transition(from_status: str, to: str, actor: str) -> bool:
    return actor in TRANSITIONS.get(from_status, {}).get(to, ())


@dataclass
class Result:
    order: Order
    changed: bool


def order_changed() -> ApiError:
    return ApiError(
        409,
        "This order was just updated by someone else. Refresh to see its latest status.",
        code="ORDER_CHANGED",
    )


def transition(
    order_id: uuid.UUID,
    *,
    to: str,
    actor: Actor,
    user: Any = None,
    scope: Q | None = None,
    where: Q | None = None,
    update: dict[str, Any] | None = None,
    note: str | None = None,
    reason: str | None = None,
    on_change: Callable[[Order], None] | None = None,
) -> Result:
    """
    Moves the order to `to`. `scope` limits which orders the caller may touch (404 otherwise);
    `where` adds conditions the write itself must still meet (409 when they no longer hold);
    `update` sets other columns in the same write; `on_change` runs in the same transaction.
    """
    scope = scope or Q()
    order = Order.objects.filter(Q(pk=order_id) & scope).first()
    if order is None:
        raise ApiError.not_found("Order not found")
    if order.status == to:
        return Result(presenters.reload(order), False)
    if not can_transition(order.status, to, actor):
        raise ApiError(
            409,
            f"This order is {LABEL[order.status]} and cannot be {LABEL[to]} now",
            code="INVALID_TRANSITION",
        )

    previous_status = order.status
    previous_rider = order.delivery_partner_id
    offered_rider = (
        DeliveryAssignment.objects.filter(order=order, status=AssignmentStatus.OFFERED)
        .values_list("rider_id", flat=True)
        .first()
    )
    now = timezone.now()
    fields: dict[str, Any] = {"status": to, "status_changed_at": now, "updated_at": now}
    fields.update(update or {})
    if to == S.DELIVERED:
        # Cash is collected on delivery; online orders were paid already.
        fields["payment_status"] = PaymentStatus.PAID
    if to == S.PICKED_UP and settings.DELIVERY_OTP_REQUIRED:
        # The customer reads this code to the rider at the door (orders.services#rider_set_status).
        fields["delivery_otp"] = new_delivery_otp()
        fields["delivery_otp_attempts"] = 0

    with transaction.atomic():
        written = Order.objects.filter(
            Q(pk=order.pk, status=previous_status) & scope & (where or Q())
        ).update(**fields)
        if not written:
            current = Order.objects.filter(pk=order.pk).values_list("status", flat=True).first()
            if current == to:
                return Result(presenters.reload(order), False)
            raise order_changed()

        OrderStatusHistory.objects.create(
            order_id=order.pk,
            from_status=previous_status,
            to_status=to,
            actor_role=str(actor),
            actor=user,
            note=(note or reason or "")[:300],
        )
        if to in (S.REJECTED, S.CANCELLED):
            OrderCancellation.objects.create(order_id=order.pk, by=str(actor), reason=reason or "")
        order.refresh_from_db()
        if to == S.DELIVERED:
            OrderSettlement.objects.create(order=order, settled_at=now, **settlement_for(order))
        if on_change is not None:
            on_change(order)
        _after_transition(order, now)
        updated = presenters.reload(order)
        emit_order_updated(updated, also_notify=[offered_rider, previous_rider])
        notify_status_change(updated, str(actor), previous_rider, reason)

    logger.info(
        "Order status changed",
        extra={"order_id": str(order.pk), "from": previous_status, "to": to, "actor": str(actor)},
    )
    return Result(updated, True)


def _step(name: str, order: Order, work: Callable[[], Any]) -> None:
    try:
        with transaction.atomic():
            work()
    except Exception:
        logger.exception("Order follow-up step failed", extra={"order_id": str(order.pk)})


def _after_transition(order: Order, now: Any) -> None:
    if order.status in (S.REJECTED, S.CANCELLED):
        _step("coupon", order, lambda: release_coupon(order))
        _step("payment", order, lambda: settle_cancelled_payment(order))
        _step("rider", order, lambda: release_rider(order))
        _step(
            "assignments",
            order,
            lambda: DeliveryAssignment.objects.filter(
                order=order, status__in=[s.value for s in LIVE_STATUSES]
            ).update(status=AssignmentStatus.CANCELLED, responded_at=now),
        )
    if order.status == S.DELIVERED:
        _step(
            "payment",
            order,
            lambda: Payment.objects.filter(
                order=order, method=PaymentMethod.COD, status=PaymentStatus.PENDING
            ).update(status=PaymentStatus.PAID, paid_at=now, updated_at=now),
        )
        _step(
            "rider",
            order,
            lambda: DeliveryPartner.objects.filter(active_order=order).update(
                active_order=None,
                completed_deliveries=F("completed_deliveries") + 1,
                updated_at=now,
            ),
        )
        _step(
            "assignment",
            order,
            lambda: DeliveryAssignment.objects.filter(
                order=order, status=AssignmentStatus.ACCEPTED
            ).update(status=AssignmentStatus.COMPLETED, responded_at=now),
        )


def release_coupon(order: Order) -> None:
    """A closed order gives its coupon use back, once (the redemption record is the token)."""
    if not order.coupon_code:
        return
    redemption = CouponRedemption.objects.filter(order=order).first()
    if redemption is None:
        return
    deleted, _ = CouponRedemption.objects.filter(pk=redemption.pk).delete()
    if deleted:
        Coupon.objects.filter(pk=redemption.coupon_id, used_count__gt=0).update(
            used_count=F("used_count") - 1
        )


def settle_cancelled_payment(order: Order) -> None:
    """Refunds a paid online order, or closes the unpaid payment (apps/payments/services.py)."""
    from apps.payments.services import settle_cancelled_payment as settle

    settle(order)


def release_rider(order: Order) -> None:
    """Frees whichever rider was offered or carrying this order."""
    DeliveryPartner.objects.filter(current_offer=order).update(current_offer=None)
    DeliveryPartner.objects.filter(active_order=order).update(active_order=None)
