"""
Notifications (Node: services/notification.service.js). `notify()` stores one inbox row per user;
the realtime event (Phase 7) and Web Push (Phase 9) hook in through `delivery_hooks`. It is
best-effort: a failure is logged and never fails the caller's action.
"""

import functools
import logging
import uuid
from collections.abc import Callable, Iterable
from typing import Any

from django.db import transaction

from apps.accounts.models import User, UserStatus
from apps.rbac.roles import ADMIN_ROLES, Permission, Role, has_permission

from .models import Notification

logger = logging.getLogger("bitebox.notifications")

# Called after commit with the stored notifications (realtime emit, push).
delivery_hooks: list[Callable[[list[Notification]], None]] = []


def notify(
    user_ids: Iterable[Any] | Any,
    *,
    type: str,
    title: str,
    body: str = "",
    link: str = "",
    order: Any = None,
) -> None:
    ids = user_ids if isinstance(user_ids, (list, tuple, set)) else [user_ids]
    users = list(dict.fromkeys(str(u) for u in ids if u))
    if not users:
        return
    try:
        with transaction.atomic():
            rows = Notification.objects.bulk_create(
                [
                    Notification(
                        user_id=uuid.UUID(u),
                        type=type,
                        title=title,
                        body=body or "",
                        link=link or "",
                        order=order,
                    )
                    for u in users
                ]
            )
        for hook in delivery_hooks:
            transaction.on_commit(functools.partial(_safe, hook, rows))
    except Exception:
        logger.exception("Could not store notification", extra={"type": type})


def _safe(hook: Callable[[list[Notification]], None], rows: list[Notification]) -> None:
    try:
        hook(rows)
    except Exception:
        logger.exception("Notification delivery failed")


def notify_admins(permission: Permission, **payload: Any) -> None:
    """The super admin plus every admin role holding `permission` (active accounts only)."""
    roles = [r for r in ADMIN_ROLES if r == Role.ADMIN or has_permission(r, permission)]
    ids = User.objects.filter(role__in=roles, status=UserStatus.ACTIVE).values_list("id", flat=True)
    notify(list(ids), **payload)
