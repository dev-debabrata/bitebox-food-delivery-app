"""
In-app notifications for orders (Node: services/order-notifications.js). Same titles and texts.
All of it is best-effort: `notify` logs failures and never raises.
"""

from typing import Any

from apps.notifications.services import notify, notify_admins
from apps.rbac.roles import Permission
from apps.realtime.events import emit_order_updated
from apps.restaurants.models import Restaurant

from .models import Order, OrderStatus

S = OrderStatus


def rupees(paise: int) -> str:
    text = f"{paise / 100:.2f}"
    return f"₹{text[:-3] if text.endswith('.00') else text}"


def _ref(order: Order) -> str:
    return f"Order {order.order_number}"


def _dishes(order: Order) -> str:
    n = len(order.items.all())
    return f"{n} dish{'' if n == 1 else 'es'}"


def _type(order: Order) -> str:
    return f"order.{order.status}"


def _to_customer(order: Order, title: str, body: str, type: str | None = None) -> None:
    notify(
        order.customer_id,
        type=type or _type(order),
        title=title,
        body=body,
        link=f"/orders/{order.pk}",
        order=order,
    )


def _to_restaurant(order: Order, title: str, body: str, type: str | None = None) -> None:
    owner = Restaurant.objects.filter(pk=order.restaurant_id).values_list("owner_id", flat=True)
    notify(
        list(owner),
        type=type or _type(order),
        title=title,
        body=body,
        link="/restaurant/orders",
        order=order,
    )


def _to_rider(rider_id: Any, order: Order, title: str, body: str, type: str | None = None) -> None:
    notify(
        rider_id, type=type or _type(order), title=title, body=body, link="/delivery", order=order
    )


def _to_admins(
    order: Order, title: str, body: str, *, type: str | None = None, link: str = "/admin/orders"
) -> None:
    notify_admins(
        Permission.ORDERS_MANAGE,
        type=type or _type(order),
        title=title,
        body=body,
        link=link,
        order=order,
    )


def notify_new_order(order: Order, how: str) -> None:
    """The order has just reached the restaurant (cash: when placed; online: once paid)."""
    emit_order_updated(order)  # the restaurant's board lights up
    name = order.restaurant_snapshot.get("name", "")
    summary = f"{_dishes(order)} · {rupees(order.total_paise)} · {how}"
    _to_restaurant(order, f"New order {order.order_number}", summary, "order.new")
    _to_customer(order, f"{_ref(order)} placed", f"{name} will confirm it shortly.", "order.placed")
    _to_admins(order, f"New order {order.order_number}", f"{name} · {summary}", type="order.new")


def notify_offer(order: Order, rider_id: Any) -> None:
    """A rider has been offered a delivery (they have a short time to accept)."""
    a = order.delivery_address
    _to_rider(
        rider_id,
        order,
        "New delivery request",
        f"{order.restaurant_snapshot.get('name', '')} → {a.get('area') or a.get('city')}. "
        "Accept it soon.",
        "order.offer",
    )


def notify_status_change(order: Order, actor: str, previous_rider: Any, reason: str | None) -> None:
    """`previous_rider` is the order's rider before the change (if any)."""
    r = _ref(order)
    name = order.restaurant_snapshot.get("name", "")
    status = order.status
    if status == S.CONFIRMED:
        _to_customer(order, f"{r} accepted", f"{name} is getting your food ready.")
    elif status == S.PREPARING:
        _to_customer(order, f"{r} is being prepared", f"{name} has started cooking your food.")
    elif status == S.REJECTED:
        _to_customer(
            order, f"{r} could not be accepted", reason or f"{name} could not take this order."
        )
        _to_admins(order, f"{r} rejected", f"{name}: {reason or 'no reason given'}")
    elif status == S.READY_FOR_PICKUP:
        if previous_rider:
            _to_rider(
                previous_rider,
                order,
                f"{r} reassigned",
                "BiteBox support gave it to another rider.",
            )
    elif status == S.ASSIGNED:
        _to_customer(
            order, "A rider is on the way to the restaurant", f"{r} has a delivery partner."
        )
        _to_restaurant(order, f"Rider assigned to {r}", "Keep the order ready for pickup.")
    elif status == S.ARRIVED_AT_RESTAURANT:
        _to_restaurant(order, f"Rider has arrived for {r}", "Hand the order to the rider.")
    elif status == S.PICKED_UP:
        _to_customer(
            order,
            f"{r} picked up",
            f"Your rider has collected your food. Your delivery code is {order.delivery_otp}: "
            "share it with the rider only when you have your order."
            if order.delivery_otp
            else "Your rider has collected your food from the restaurant.",
        )
        _to_restaurant(order, f"{r} picked up", "The rider has collected it.")
    elif status == S.ON_THE_WAY:
        _to_customer(order, f"{r} is out for delivery", "Track your rider live on the order page.")
    elif status == S.DELIVERED:
        _to_customer(order, f"{r} delivered", "Enjoy your meal!")
        _to_restaurant(order, f"{r} delivered", "Earnings are updated.")
        _to_admins(order, f"{r} delivered", f"{name} · {rupees(order.total_paise)}")
    elif status == S.CANCELLED:
        if order.submitted_at:
            _to_admins(order, f"{r} cancelled", f"By {actor}{f': {reason}' if reason else ''}")
        if actor != "customer":
            _to_customer(order, f"{r} cancelled", reason or "This order was cancelled.")
        if order.submitted_at and actor != "restaurant":
            _to_restaurant(
                order,
                f"{r} cancelled",
                "The customer cancelled before you accepted it."
                if actor == "customer"
                else reason or "",
            )
        if previous_rider:
            _to_rider(previous_rider, order, f"{r} cancelled", "You no longer need to deliver it.")


def notify_new_delivery_otp(order: Order) -> None:
    """Support reset the delivery code (the rider ran out of tries)."""
    _to_customer(
        order,
        f"New delivery code for {_ref(order)}",
        f"Your new code is {order.delivery_otp}. Share it with the rider at your door.",
        "order.delivery_code",
    )


def notify_refund(order: Order, amount_paise: int, ok: bool) -> None:
    """A refund went through (customer and finance told) or failed (finance retries it)."""
    link = "/admin/payments"
    if not ok:
        notify_admins(
            Permission.REFUNDS_MANAGE,
            type="payment.refund_failed",
            title=f"Refund failed for {order.order_number}",
            body=f"{rupees(amount_paise)} could not be refunded. Retry it from Payments.",
            link=link,
            order=order,
        )
        return
    _to_customer(
        order,
        f"Refund of {rupees(amount_paise)} processed",
        f"For {_ref(order)}. It reaches your account in a few working days.",
        "payment.refunded",
    )
    notify_admins(
        Permission.REFUNDS_MANAGE,
        type="payment.refunded",
        title=f"Refunded {order.order_number}",
        body=rupees(amount_paise),
        link=link,
        order=order,
    )


def notify_payment_failed(order: Order, reason: str) -> None:
    """The online payment did not go through (the customer can try again from the order)."""
    _to_customer(
        order,
        f"Payment for {_ref(order)} did not go through",
        f"{reason}. You have not been charged. Try again from your order.",
        "payment.failed",
    )


def notify_refund_started(order: Order, amount_paise: int) -> None:
    _to_customer(
        order,
        f"Refund of {rupees(amount_paise)} started",
        f"For {_ref(order)}. We will tell you when your bank confirms it.",
        "payment.refund_started",
    )


def notify_approaching(order: Order) -> None:
    """The rider is close to the customer (sent once per order)."""
    code = f" Keep your delivery code {order.delivery_otp} ready." if order.delivery_otp else ""
    _to_customer(
        order,
        "Your rider is almost there",
        f"{_ref(order)} is a few minutes away.{code}",
        "order.approaching",
    )
