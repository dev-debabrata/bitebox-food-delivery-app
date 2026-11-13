"""
Orders in the Node API's JSON shape (Order.toJSON), and what each role may see
(Node: services/order-management.service.js). Keys are snake_case; the renderer camelCases them.

- `order_json`: the order without internal finance (settlement, payouts, the offer).
- `present_with_rider`: customer and admin; adds the rider's card and the payment's state.
- `present_for_restaurant`: no customer phone or exact address; adds respondBy / pickupBy.
- `present_for_rider`: the full address only once they carry the order; no cancellation.
"""

from datetime import timedelta
from typing import Any

from django.conf import settings
from django.db.models import Prefetch, QuerySet

from apps.delivery.models import DeliveryPartner
from apps.dispatch.config import DISPATCH
from apps.dispatch.models import AssignmentStatus, DeliveryAssignment
from apps.finance.earnings import settlement_for
from apps.payments.models import Payment

from .models import Order, OrderCancellation, OrderStatus

S = OrderStatus


def with_details(qs: QuerySet[Order]) -> QuerySet[Order]:
    """Everything the presenters read, in a fixed number of queries."""
    return qs.select_related("cancellation", "payment").prefetch_related(
        "items",
        "status_history",
        Prefetch(
            "assignments",
            queryset=DeliveryAssignment.objects.filter(status=AssignmentStatus.OFFERED),
            to_attr="open_offers",
        ),
    )


def load(order_id: Any, **scope: Any) -> Order | None:
    return with_details(Order.objects.filter(pk=order_id, **scope)).first()


def reload(order: Order) -> Order:
    fresh = load(order.pk)
    if fresh is None:  # deleted meanwhile (never happens: orders are protected)
        raise Order.DoesNotExist
    return fresh


def _cancellation(order: Order) -> OrderCancellation | None:
    try:
        return order.cancellation
    except OrderCancellation.DoesNotExist:
        return None


def payment_of(order: Order) -> Payment | None:
    try:
        return order.payment
    except Payment.DoesNotExist:
        return None


def open_offer(order: Order) -> DeliveryAssignment | None:
    offers = getattr(order, "open_offers", None)
    if offers is None:
        offers = list(order.assignments.filter(status=AssignmentStatus.OFFERED))
    return offers[0] if offers else None


def ready_at(order: Order) -> Any:
    """When the order (last) became ready for pickup; the pickup window counts from here."""
    times = [h.created_at for h in order.status_history.all() if h.to_status == S.READY_FOR_PICKUP]
    return times[0] if times else None


def order_json(order: Order) -> dict[str, Any]:
    payment = payment_of(order)
    cancellation = _cancellation(order)
    data: dict[str, Any] = {
        "id": str(order.pk),
        "order_number": order.order_number,
        "customer": str(order.customer_id),
        "restaurant": str(order.restaurant_id),
        "restaurant_snapshot": order.restaurant_snapshot,
        "items": [
            {
                "food_item": str(i.food_item_id),
                "name": i.name,
                "is_veg": i.is_veg,
                "unit_price_paise": i.unit_price_paise,
                "quantity": i.quantity,
                "line_total_paise": i.line_total_paise,
            }
            for i in sorted(order.items.all(), key=lambda i: i.created_at)
        ],
        "delivery_address": order.delivery_address,
        "pricing": {
            "subtotal_paise": order.subtotal_paise,
            "discount_paise": order.discount_paise,
            "delivery_fee_paise": order.delivery_fee_paise,
            "platform_fee_paise": order.platform_fee_paise,
            "tax_paise": order.tax_paise,
            "coin_discount_paise": order.coin_discount_paise,
            "total_paise": order.total_paise,
        },
        "coins": {
            "redeemed": order.coins_redeemed,
            "discount_paise": order.coin_discount_paise,
            "state": order.coins_state,
            "earned": order.coins_earned,
        },
        "distance_meters": order.distance_m,
        "status": order.status,
        "status_history": [
            {
                "status": h.to_status,
                "at": h.created_at,
                "by": str(h.actor_id) if h.actor_id else None,
                **({"note": h.note} if h.note else {}),
            }
            for h in order.status_history.all()
        ],
        "payment_method": order.payment_method,
        "payment_status": order.payment_status,
        "payment": str(payment.pk) if payment else None,
        "submitted_at": order.submitted_at,
        "delivery_partner": str(order.delivery_partner_id) if order.delivery_partner_id else None,
        # Set when the restaurant accepts: its preparation time and the expected ready time.
        "prep_minutes": order.prep_minutes,
        "ready_by": order.ready_by,
        "created_at": order.created_at,
        "updated_at": order.updated_at,
    }
    if order.coupon_code:
        data["coupon"] = {"code": order.coupon_code, "discount_paise": order.discount_paise}
    if order.note:
        data["note"] = order.note
    if cancellation:
        data["cancellation"] = {
            "by": cancellation.by,
            **({"reason": cancellation.reason} if cancellation.reason else {}),
            "at": cancellation.created_at,
        }
    return data


def list_json(order: Order) -> dict[str, Any]:
    """The list rows (Node selected only these fields)."""
    return {
        "id": str(order.pk),
        "order_number": order.order_number,
        "restaurant": str(order.restaurant_id),
        "restaurant_snapshot": {
            "name": order.restaurant_snapshot.get("name"),
            "slug": order.restaurant_snapshot.get("slug"),
        },
        "items": [
            {
                "food_item": str(i.food_item_id),
                "name": i.name,
                "is_veg": i.is_veg,
                "unit_price_paise": i.unit_price_paise,
                "quantity": i.quantity,
                "line_total_paise": i.line_total_paise,
            }
            for i in sorted(order.items.all(), key=lambda i: i.created_at)
        ],
        "pricing": {"total_paise": order.total_paise},
        "status": order.status,
        "payment_method": order.payment_method,
        "payment_status": order.payment_status,
        "delivery_partner": str(order.delivery_partner_id) if order.delivery_partner_id else None,
        "created_at": order.created_at,
        "updated_at": order.updated_at,
    }


def payment_view(payment: Payment) -> dict[str, Any]:
    return {
        "status": payment.status,
        "method": payment.method,
        "provider": payment.provider,
        "simulated": payment.provider == "mock",
        "amount_paise": payment.amount_paise,
        "refunded_paise": payment.refunded_paise,
        "paid_at": payment.paid_at,
        "refunded_at": payment.refunded_at,
        "failure_reason": payment.failure_reason or None,
    }


def rider_card(user_id: Any) -> dict[str, Any] | None:
    """The rider's public card (name, phone, vehicle), for the customer and admin."""
    if not user_id:
        return None
    profile = (
        DeliveryPartner.objects.select_related("user", "vehicle").filter(user_id=user_id).first()
    )
    if profile is None:
        from apps.accounts.models import User

        user = User.objects.filter(pk=user_id).first()
        if user is None:
            return None
        return {
            "id": str(user.pk),
            "name": user.name,
            "phone": user.phone or None,
            "vehicle_type": None,
            "vehicle_number": None,
            "rating": None,
        }
    vehicle = getattr(profile, "vehicle", None)
    return {
        "id": str(profile.user_id),
        "name": profile.user.name,
        "phone": profile.user.phone or None,
        "vehicle_type": vehicle.vehicle_type if vehicle else None,
        "vehicle_number": vehicle.vehicle_number if vehicle else None,
        "rating": {"average": float(profile.rating_average), "count": profile.rating_count}
        if profile.rating_count
        else None,
    }


def present_with_rider(order: Order, *, for_customer: bool = False) -> dict[str, Any]:
    """
    Customer and admin view. Only the customer sees the delivery OTP (they read it to the rider);
    admins see whether one is pending and how many wrong tries there were.
    """
    data = order_json(order)
    payment = payment_of(order)
    data["rider"] = rider_card(order.delivery_partner_id)
    data["payment"] = payment_view(payment) if payment else None
    if payment is not None:
        data["payment"]["refunds"] = [
            {
                "id": str(r.pk),
                "amount_paise": r.amount_paise,
                "status": r.status,
                "reason": r.reason or None,
                "created_at": r.created_at,
                "processed_at": r.processed_at,
            }
            for r in payment.refunds.order_by("created_at")
        ]
    otp_pending = bool(order.delivery_otp) and order.status in (S.PICKED_UP, S.ON_THE_WAY)
    if for_customer:
        data["delivery_otp"] = order.delivery_otp if otp_pending else None
    else:
        data["delivery_otp_pending"] = otp_pending
        data["delivery_otp_attempts"] = order.delivery_otp_attempts
        # Where the rider was when they marked "arrived" (far arrivals are flagged, not refused).
        data["arrival_distance_meters"] = order.arrival_distance_m
        data["arrived_far"] = (
            order.arrival_distance_m is not None
            and order.arrival_distance_m > settings.ARRIVAL_FAR_METERS
        )
    return data


def present_for_restaurant(order: Order) -> dict[str, Any]:
    data = order_json(order)
    a = order.delivery_address
    data["delivery_address"] = {
        "recipient_name": a.get("recipient_name"),
        "area": a.get("area"),
        "city": a.get("city"),
    }
    data["rider_assigned"] = bool(order.delivery_partner_id)
    if order.status == S.PENDING and order.submitted_at:
        data["respond_by"] = order.submitted_at + timedelta(
            minutes=DISPATCH["restaurant_response_minutes"]
        )
    if order.status in (S.READY_FOR_PICKUP, S.ASSIGNED, S.ARRIVED_AT_RESTAURANT) and (
        at := ready_at(order)
    ):
        data["pickup_by"] = at + timedelta(minutes=DISPATCH["pickup_window_minutes"])
    return data


def present_for_rider(order: Order, user_id: Any) -> dict[str, Any]:
    data = order_json(order)
    if str(order.delivery_partner_id) != str(user_id):
        a = order.delivery_address
        data["delivery_address"] = {
            "area": a.get("area"),
            "city": a.get("city"),
            "location": a.get("location"),
        }
    offer = open_offer(order)
    data["offer_expires_at"] = offer.expires_at if offer else None
    data["offer_window_seconds"] = DISPATCH["offer_timeout_seconds"]
    # What the rider earns for this delivery (fixed by distance, before they accept).
    data["estimated_earnings_paise"] = settlement_for(order, commission_bp=0)["rider_paise"]
    # The rider's next allowed moves, in order (the app shows the first as its main button), and
    # whether "delivered" needs the customer's code. Never the code itself.
    carrying = str(order.delivery_partner_id) == str(user_id)
    data["next_statuses"] = RIDER_NEXT.get(order.status, []) if carrying else []
    data["delivery_otp_required"] = carrying and bool(order.delivery_otp)
    data.pop("cancellation", None)
    return data


RIDER_NEXT: dict[str, list[str]] = {
    S.ASSIGNED: [S.ARRIVED_AT_RESTAURANT, S.PICKED_UP],
    S.ARRIVED_AT_RESTAURANT: [S.PICKED_UP],
    S.PICKED_UP: [S.ON_THE_WAY],
    S.ON_THE_WAY: [S.DELIVERED],
}
