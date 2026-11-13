"""
Notifications (Node: services/notification.service.js and push.service.js), extended for the
master prompt §11.

`notify()` stores one inbox row per user (the in-app channel, always on), then plans one
`NotificationDelivery` per external channel the type uses, the person allows and can be reached
on (Web Push, FCM, email, SMS). Each delivery is sent by a Celery task after commit, one attempt
at a time: a temporary failure is retried with back-off by `retry_due()` (Celery Beat), and after
MAX_ATTEMPTS it becomes a dead letter admins can retry. Nothing here ever fails the caller.
"""

import functools
import logging
import uuid
from collections.abc import Callable, Iterable
from datetime import UTC, datetime, timedelta
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Count, Q
from django.utils import timezone

from apps.accounts.models import User, UserStatus
from apps.rbac.roles import ADMIN_ROLES, Permission, Role, has_permission
from common.api import ApiError
from common.pagination import Page, paginate

from . import content, senders
from .models import (
    NOTIFICATION_RETENTION_DAYS,
    Channel,
    ChannelPreference,
    DeliveryStatus,
    DeviceToken,
    Notification,
    NotificationDelivery,
    PushSubscription,
)

logger = logging.getLogger("bitebox.notifications")

D = DeliveryStatus
MAX_ATTEMPTS = 5
BACKOFF_SECONDS = (60, 5 * 60, 15 * 60, 60 * 60)  # after the 1st, 2nd, 3rd, 4th failure
LEASE = timedelta(minutes=5)  # a claimed delivery is not picked up again meanwhile
MAX_DEVICES_PER_USER = 10

# Called after commit with the stored notifications (the realtime `notification:new` event).
delivery_hooks: list[Callable[[list[Notification]], None]] = []


# ---------------------------------------------------------------------------
# notify
# ---------------------------------------------------------------------------
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
                        title=title[:120],
                        body=(body or "")[:300],
                        link=(link or "")[:200],
                        order=order,
                    )
                    for u in users
                ]
            )
            deliveries = NotificationDelivery.objects.bulk_create(_plan(rows))
        for hook in delivery_hooks:
            transaction.on_commit(functools.partial(_safe, hook, rows))
        for delivery in deliveries:
            transaction.on_commit(functools.partial(_enqueue, delivery.pk))
    except Exception:
        logger.exception("Could not store notification", extra={"type": type})


def _safe(hook: Callable[[list[Notification]], None], rows: list[Notification]) -> None:
    try:
        hook(rows)
    except Exception:
        logger.exception("Notification delivery failed")


def _enqueue(delivery_id: Any) -> None:
    from .tasks import deliver

    try:
        deliver.delay(str(delivery_id))
    except Exception:  # the broker is down: retry_due() picks it up later
        logger.exception("Could not queue a notification delivery")


def _plan(rows: list[Notification]) -> list[NotificationDelivery]:
    """The external deliveries for these inbox rows (all of one type)."""
    if not rows:
        return []
    type = rows[0].type
    category = content.category_of(type)
    wanted = [c for c in content.channels_for(type) if senders.channel_enabled(c)]
    if not wanted:
        return []
    user_ids = [r.user_id for r in rows]
    users = {
        u.pk: u
        for u in User.objects.filter(pk__in=user_ids, status=UserStatus.ACTIVE).select_related(
            "channel_preferences"
        )
    }
    with_browser = set(
        PushSubscription.objects.filter(user_id__in=user_ids).values_list("user_id", flat=True)
    )
    with_app = set(
        DeviceToken.objects.filter(user_id__in=user_ids).values_list("user_id", flat=True)
    )
    deliveries = []
    for row in rows:
        user = users.get(row.user_id)
        if user is None or (category == "promotions" and user.role != Role.CUSTOMER):
            continue
        for channel in wanted:
            if _allows(user, channel, category) and _reachable(
                user, channel, with_browser, with_app
            ):
                deliveries.append(
                    NotificationDelivery(notification=row, user=user, channel=channel)
                )
    return deliveries


def _channel_prefs(user: User) -> ChannelPreference:
    try:
        return user.channel_preferences
    except ChannelPreference.DoesNotExist:
        return ChannelPreference(user=user)  # unsaved: the defaults


def _allows(user: User, channel: str, category: str) -> bool:
    if channel in (Channel.PUSH, Channel.FCM):
        return bool(getattr(user, f"push_{category}"))
    return bool(getattr(_channel_prefs(user), f"{channel}_{category}"))


def _reachable(user: User, channel: str, with_browser: set[Any], with_app: set[Any]) -> bool:
    return {
        Channel.PUSH: user.pk in with_browser,
        Channel.FCM: user.pk in with_app,
        Channel.EMAIL: bool(user.email),
        Channel.SMS: bool(user.phone),
    }[Channel(channel)]


def notify_admins(permission: Permission, **payload: Any) -> None:
    """The super admin plus every admin role holding `permission` (active accounts only)."""
    roles = [r for r in ADMIN_ROLES if r == Role.ADMIN or has_permission(r, permission)]
    ids = User.objects.filter(role__in=roles, status=UserStatus.ACTIVE).values_list("id", flat=True)
    notify(list(ids), **payload)


# ---------------------------------------------------------------------------
# Delivery attempts
# ---------------------------------------------------------------------------
def attempt(delivery_id: Any, now: datetime | None = None) -> str | None:
    """One try at one delivery. Returns its new status (None when not due or not found)."""
    now = now or timezone.now()
    due = Q(next_attempt_at__isnull=True) | Q(next_attempt_at__lte=now)
    claimed = NotificationDelivery.objects.filter(
        Q(pk=delivery_id, status__in=[D.QUEUED, D.FAILED]) & due
    ).update(next_attempt_at=now + LEASE, updated_at=now)
    if not claimed:
        return None  # sent, dead, or another worker has it
    delivery = NotificationDelivery.objects.select_related("notification", "user").get(
        pk=delivery_id
    )
    tries = delivery.attempts + 1
    fields: dict[str, Any] = {"attempts": tries, "updated_at": timezone.now()}
    try:
        if not senders.channel_enabled(delivery.channel):
            raise senders.Skip(f"{delivery.channel} is off")
        senders.sender_for(delivery.channel)(delivery)
    except senders.Skip as reason:
        fields.update(status=D.SKIPPED, last_error=str(reason)[:500], next_attempt_at=None)
    except senders.PermanentFailure as error:
        fields.update(status=D.DEAD, last_error=str(error)[:500], next_attempt_at=None)
        logger.error("Notification dead letter", extra={"delivery": str(delivery.pk)})
    except Exception as error:
        message = f"{type(error).__name__}: {error}"[:500]
        if tries >= MAX_ATTEMPTS:
            fields.update(status=D.DEAD, last_error=message, next_attempt_at=None)
            logger.error("Notification dead letter", extra={"delivery": str(delivery.pk)})
        else:
            wait = BACKOFF_SECONDS[min(tries, len(BACKOFF_SECONDS)) - 1]
            fields.update(
                status=D.FAILED, last_error=message, next_attempt_at=now + timedelta(seconds=wait)
            )
    else:
        fields.update(status=D.SENT, sent_at=timezone.now(), last_error="", next_attempt_at=None)
    NotificationDelivery.objects.filter(pk=delivery.pk).update(**fields)
    return str(fields["status"])


def retry_due(now: datetime | None = None) -> int:
    """Celery Beat: queues failed deliveries whose wait is over, and queued ones never picked up."""
    now = now or timezone.now()
    due = NotificationDelivery.objects.filter(
        Q(status=D.FAILED, next_attempt_at__lte=now)
        | Q(
            status=D.QUEUED,
            next_attempt_at__isnull=True,
            created_at__lte=now - timedelta(minutes=2),
        )
        | Q(status=D.QUEUED, next_attempt_at__lte=now)  # a worker died holding the lease
    ).values_list("pk", flat=True)[:500]
    ids = list(due)
    for delivery_id in ids:
        _enqueue(delivery_id)
    return len(ids)


def purge(now: datetime | None = None) -> int:
    """Celery Beat (daily): inbox rows (and their deliveries) older than the retention period."""
    cutoff = (now or timezone.now()) - timedelta(days=NOTIFICATION_RETENTION_DAYS)
    deleted, _ = Notification.objects.filter(created_at__lt=cutoff).delete()
    return deleted


# ---------------------------------------------------------------------------
# Inbox
# ---------------------------------------------------------------------------
def notification_json(n: Notification) -> dict[str, Any]:
    return {
        "id": str(n.pk),
        "type": n.type,
        "title": n.title,
        "body": n.body,
        "link": n.link,
        "order": str(n.order_id) if n.order_id else None,
        "read_at": n.read_at,
        "created_at": n.created_at,
    }


def inbox(user: User, page: Page, unread_only: bool = False) -> dict[str, Any]:
    """Newest first; `unread` is always the full unread count (Node: notification.service#list)."""
    qs = Notification.objects.filter(user=user)
    if unread_only:
        qs = qs.filter(read_at__isnull=True)
    rows, meta = paginate(qs.order_by("-created_at"), page)
    return {
        "items": [notification_json(n) for n in rows],
        "unread": Notification.objects.filter(user=user, read_at__isnull=True).count(),
        "pagination": meta,
    }


def mark_read(user: User, notification_id: uuid.UUID) -> dict[str, Any]:
    n = Notification.objects.filter(pk=notification_id, user=user).first()
    if n is None:
        raise ApiError.not_found("Notification not found")
    if n.read_at is None:
        n.read_at = timezone.now()
        Notification.objects.filter(pk=n.pk).update(read_at=n.read_at)
    return notification_json(n)


def mark_all_read(user: User) -> dict[str, int]:
    updated = Notification.objects.filter(user=user, read_at__isnull=True).update(
        read_at=timezone.now()
    )
    return {"updated": updated}


def clear_all(user: User) -> dict[str, int]:
    deleted, _ = Notification.objects.filter(user=user).delete()
    return {"deleted": deleted}


# ---------------------------------------------------------------------------
# Preferences
# ---------------------------------------------------------------------------
def _categories(user: User) -> list[str]:
    """Promotions are only ever sent to customers."""
    return list(content.CATEGORIES) if user.role == Role.CUSTOMER else ["orders", "account"]


def push_preferences(user: User) -> dict[str, Any]:
    """GET /push/preferences (Node parity)."""
    return {
        "preferences": {c: getattr(user, f"push_{c}") for c in content.CATEGORIES},
        "categories": _categories(user),
        "devices": PushSubscription.objects.filter(user=user).count(),
        "enabled": senders.push_enabled(),
    }


def update_push_preferences(user: User, changes: dict[str, bool]) -> dict[str, Any]:
    fields = {f"push_{c}": v for c, v in changes.items() if c in content.CATEGORIES}
    if fields:
        User.objects.filter(pk=user.pk).update(**fields)
        user.refresh_from_db(fields=list(fields))
    return push_preferences(user)


def channel_preferences(user: User) -> dict[str, Any]:
    """Every channel's switches, and which channels are available right now."""
    prefs = _channel_prefs(user)
    return {
        "channels": {
            "push": {c: getattr(user, f"push_{c}") for c in content.CATEGORIES},
            "email": {c: getattr(prefs, f"email_{c}") for c in content.CATEGORIES},
            "sms": {c: getattr(prefs, f"sms_{c}") for c in content.CATEGORIES},
        },
        "categories": _categories(user),
        "available": {
            "push": senders.push_enabled(),
            "email": senders.channel_enabled(Channel.EMAIL) and bool(user.email),
            "sms": senders.sms_enabled() and bool(user.phone),
        },
    }


def update_channel_preferences(user: User, changes: dict[str, dict[str, bool]]) -> dict[str, Any]:
    push = changes.get("push") or {}
    if push:
        update_push_preferences(user, push)
    fields = {
        f"{channel}_{c}": v
        for channel in ("email", "sms")
        for c, v in (changes.get(channel) or {}).items()
        if c in content.CATEGORIES
    }
    if fields:
        ChannelPreference.objects.update_or_create(user=user, defaults=fields)
        user.refresh_from_db()
    return channel_preferences(user)


# ---------------------------------------------------------------------------
# Web Push subscriptions and promotions
# ---------------------------------------------------------------------------
_BROWSERS = (
    ("Edg/", "Edge"),
    ("OPR/", "Opera"),
    ("Opera", "Opera"),
    ("Firefox/", "Firefox"),
    ("SamsungBrowser/", "Samsung Internet"),
    ("Chrome/", "Chrome"),
    ("Safari/", "Safari"),
)
_SYSTEMS = (
    ("Android", "Android"),
    ("iPhone", "iOS"),
    ("iPad", "iOS"),
    ("Windows", "Windows"),
    ("Mac OS X", "macOS"),
    ("Linux", "Linux"),
)


def device_label(user_agent: str) -> str:
    """A short, non-identifying label such as "Chrome on Android"."""
    browser = next((name for token, name in _BROWSERS if token in user_agent), "Browser")
    system = next((name for token, name in _SYSTEMS if token in user_agent), None)
    return f"{browser} on {system}" if system else browser


def _push_unavailable() -> ApiError:
    return ApiError(503, "Push notifications are not available right now", code="PUSH_UNAVAILABLE")


def public_config() -> dict[str, Any]:
    """What the browser needs to subscribe. Only the public key is ever exposed."""
    from django.conf import settings

    return {"enabled": senders.push_enabled(), "public_key": settings.VAPID_PUBLIC_KEY or None}


def subscribe(user: User, data: dict[str, Any], user_agent: str) -> dict[str, Any]:
    if not senders.push_enabled():
        raise _push_unavailable()
    endpoint = data["endpoint"]
    if not senders.allowed_endpoint(endpoint):
        raise ApiError(
            422,
            "This browser's push service is not supported",
            code="PUSH_ENDPOINT_NOT_ALLOWED",
            details=[{"field": "endpoint", "message": "Unsupported push service"}],
        )
    expires = data.get("expiration_time")
    fields = {
        "user": user,
        "p256dh": data["keys"]["p256dh"],
        "auth": data["keys"]["auth"],
        "expiration_time": datetime.fromtimestamp(expires / 1000, tz=UTC) if expires else None,
        "device": device_label(user_agent),
        "failures": 0,
    }
    try:
        with transaction.atomic():
            sub, created = PushSubscription.objects.update_or_create(
                endpoint=endpoint, defaults=fields
            )
    except IntegrityError:  # two first subscriptions of one browser at once: update instead
        sub, created = PushSubscription.objects.update_or_create(endpoint=endpoint, defaults=fields)
    if created:  # keep only the newest few browsers per person
        stale = PushSubscription.objects.filter(user=user).order_by("-updated_at")[
            MAX_DEVICES_PER_USER:
        ]
        PushSubscription.objects.filter(pk__in=list(stale.values_list("pk", flat=True))).delete()
    return {
        "subscription": {
            "id": str(sub.pk),
            "endpoint": sub.endpoint,
            "device": sub.device,
            "expiration_time": sub.expiration_time,
            "created_at": sub.created_at,
            "updated_at": sub.updated_at,
        }
    }


def unsubscribe(user: User, endpoint: str) -> dict[str, bool]:
    deleted, _ = PushSubscription.objects.filter(user=user, endpoint=endpoint).delete()
    return {"removed": deleted > 0}


def send_promotion(title: str, body: str, link: str) -> dict[str, int]:
    """
    Pushes an offer to active customers who opted in to promotions and have a subscribed browser
    (no inbox row, like Node). Sent in the background; returns how many people it goes to.
    """
    if not senders.push_enabled():
        raise _push_unavailable()
    user_ids = list(
        PushSubscription.objects.filter(
            user__role=Role.CUSTOMER, user__status=UserStatus.ACTIVE, user__push_promotions=True
        )
        .values_list("user_id", flat=True)
        .distinct()
    )
    from .tasks import push_promotion

    transaction.on_commit(
        lambda: push_promotion.delay([str(u) for u in user_ids], title, body, link)
    )
    return {"recipients": len(user_ids)}


def deliver_promotion(user_ids: list[str], title: str, body: str, link: str) -> int:
    subscriptions = list(PushSubscription.objects.filter(user_id__in=user_ids))
    payload = senders.push_payload("promo.offer", title, body, link, None)
    return senders.push_to_subscriptions(subscriptions, payload, urgent=False)


# ---------------------------------------------------------------------------
# FCM device tokens (future native apps)
# ---------------------------------------------------------------------------
def register_device(user: User, token: str, platform: str) -> dict[str, Any]:
    device, _ = DeviceToken.objects.update_or_create(
        token=token, defaults={"user": user, "platform": platform, "failures": 0}
    )
    stale = DeviceToken.objects.filter(user=user).order_by("-updated_at")[MAX_DEVICES_PER_USER:]
    DeviceToken.objects.filter(pk__in=list(stale.values_list("pk", flat=True))).delete()
    return {"device": {"id": str(device.pk), "platform": device.platform}}


def unregister_device(user: User, token: str) -> dict[str, bool]:
    deleted, _ = DeviceToken.objects.filter(user=user, token=token).delete()
    return {"removed": deleted > 0}


# ---------------------------------------------------------------------------
# Admin: delivery log and dead letters
# ---------------------------------------------------------------------------
def _delivery_json(d: NotificationDelivery) -> dict[str, Any]:
    return {
        "id": str(d.pk),
        "channel": d.channel,
        "status": d.status,
        "attempts": d.attempts,
        "last_error": d.last_error or None,
        "next_attempt_at": d.next_attempt_at,
        "sent_at": d.sent_at,
        "created_at": d.created_at,
        "notification": {
            "id": str(d.notification_id),
            "type": d.notification.type,
            "title": d.notification.title,
        },
        "user": {"id": str(d.user_id), "name": d.user.name, "email": d.user.email},
    }


def admin_deliveries(query: dict[str, Any], page: Page) -> dict[str, Any]:
    qs = NotificationDelivery.objects.select_related("notification", "user")
    for field in ("status", "channel"):
        if query.get(field):
            qs = qs.filter(**{field: query[field]})
    rows, meta = paginate(qs.order_by("-created_at"), page)
    counts = dict(
        NotificationDelivery.objects.values_list("status").annotate(n=Count("pk")).order_by()
    )
    return {"items": [_delivery_json(d) for d in rows], "pagination": meta, "counts": counts}


def admin_retry(delivery_id: uuid.UUID) -> dict[str, Any]:
    """Sends a dead (or failed) delivery again now."""
    updated = NotificationDelivery.objects.filter(
        pk=delivery_id, status__in=[D.DEAD, D.FAILED]
    ).update(status=D.QUEUED, next_attempt_at=None, last_error="", updated_at=timezone.now())
    if not updated:
        if not NotificationDelivery.objects.filter(pk=delivery_id).exists():
            raise ApiError.not_found("Delivery not found")
        raise ApiError.conflict("Only failed or dead deliveries can be retried", "NOT_RETRYABLE")
    transaction.on_commit(functools.partial(_enqueue, delivery_id))
    d = NotificationDelivery.objects.select_related("notification", "user").get(pk=delivery_id)
    return {"delivery": _delivery_json(d)}
