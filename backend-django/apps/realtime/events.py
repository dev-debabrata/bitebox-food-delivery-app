"""
Server → client events (Node: sockets/events.js). Events carry ids and statuses only; clients
re-read the order over REST. Everything is sent after the database commit and is best-effort:
a failed send is logged and never fails the caller.

Channels group names may not contain ":", so the Node rooms map to:
`user:<id>` → `user.<id>`, `restaurant:<id>` → `restaurant.<id>`, `order:<id>` → `order.<id>`.
"""

import logging
from collections.abc import Iterable
from typing import Any

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import transaction
from django.utils import timezone

logger = logging.getLogger("bitebox.realtime")

ADMINS = "admins"


def user_group(user_id: Any) -> str:
    return f"user.{user_id}"


def restaurant_group(restaurant_id: Any) -> str:
    return f"restaurant.{restaurant_id}"


def order_group(order_id: Any) -> str:
    return f"order.{order_id}"


def _send(groups: Iterable[str], message: dict[str, Any]) -> None:
    layer = get_channel_layer()
    if layer is None:
        return
    for group in groups:
        try:
            async_to_sync(layer.group_send)(group, message)
        except Exception:
            logger.exception("Realtime emit failed", extra={"group": group})


def send_after_commit(groups: Iterable[str], event: str, data: dict[str, Any]) -> None:
    """`{"type": event, "data": data}` to every socket in `groups`, once the transaction commits."""
    targets = list(dict.fromkeys(groups))
    message = {"type": "relay", "event": event, "data": data}
    transaction.on_commit(lambda: _send(targets, message))


def emit_order_updated(order: Any, also_notify: Iterable[Any] = ()) -> None:
    """`order:updated` to the customer, the restaurant, admins and any rider involved."""
    from apps.orders.models import FINAL_STATUSES

    groups = [user_group(order.customer_id), restaurant_group(order.restaurant_id), ADMINS]
    groups += [user_group(r) for r in (order.delivery_partner_id, *also_notify) if r]
    payload = {
        "id": str(order.pk),
        "orderNumber": order.order_number,
        "status": order.status,
        "updatedAt": (order.updated_at or timezone.now()).isoformat().replace("+00:00", "Z"),
    }
    send_after_commit(groups, "order:updated", payload)
    if order.status in FINAL_STATUSES:
        # Tracking sockets leave the order's room: there is nothing left to track.
        group = order_group(order.pk)
        transaction.on_commit(lambda: _send([group], {"type": "order.closed", "group": group}))


def emit_to_users(user_ids: Iterable[Any], event: str, data: dict[str, Any]) -> None:
    send_after_commit([user_group(u) for u in user_ids if u], event, data)


def _iso(value: Any) -> str | None:
    return value.isoformat().replace("+00:00", "Z") if value else None


def emit_notifications(rows: list[Any]) -> None:
    """`notification:new` to each recipient (a `notifications.services.delivery_hooks` entry)."""
    for n in rows:
        data = {
            "id": str(n.pk),
            "user": str(n.user_id),
            "type": n.type,
            "title": n.title,
            "body": n.body,
            "link": n.link,
            "order": str(n.order_id) if n.order_id else None,
            "readAt": _iso(n.read_at),
            "createdAt": _iso(n.created_at),
            "updatedAt": _iso(n.created_at),  # notifications are append-only rows
        }
        _send([user_group(n.user_id)], {"type": "relay", "event": "notification:new", "data": data})
