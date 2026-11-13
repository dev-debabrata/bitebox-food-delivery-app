"""
Channel senders (master prompt §11): Web Push (pywebpush, VAPID), FCM (HTTP v1, for future native
apps), email (Django's mail backend, templates in content.py) and SMS (MSG91 or the console).

A sender gets the delivery row and returns normally once sent. It raises `Skip` when there is
nothing to send to any more (no browser, no phone), `PermanentFailure` when a retry cannot help,
and any other exception for a temporary failure (retried with back-off by services.attempt).
Tests swap senders with `use_sender(channel, fn)`; no test ever reaches a real provider.
"""

import json
import logging
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any
from urllib.parse import urlparse

import jwt
import requests
from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.utils import timezone

from . import content
from .models import Channel, DeviceToken, Notification, NotificationDelivery, PushSubscription

logger = logging.getLogger("bitebox.notifications")

MAX_FAILURES = 5  # a browser or device failing this many times in a row is forgotten


class Skip(Exception):
    """Nothing to deliver to (not an error)."""


class PermanentFailure(Exception):
    """Retrying cannot help (bad address, provider refused the message)."""


Sender = Callable[[NotificationDelivery], None]


# ---------------------------------------------------------------------------
# Web Push
# ---------------------------------------------------------------------------
def push_enabled() -> bool:
    return bool(settings.VAPID_PUBLIC_KEY and settings.VAPID_PRIVATE_KEY)


def allowed_endpoint(endpoint: str) -> bool:
    """Only https URLs on a known push service (an SSRF guard, like Node's isAllowedEndpoint)."""
    url = urlparse(endpoint)
    if url.scheme != "https" or url.username or url.password or url.port:
        return False
    host = (url.hostname or "").lower()
    return any(host == h or host.endswith(f".{h}") for h in settings.PUSH_ALLOWED_HOSTS)


def push_payload(type: str, title: str, body: str, link: str, order_id: Any) -> str:
    """The Angular service worker format: the browser shows it and opens `link` on click."""
    path = link if link.startswith("/") and not link.startswith("//") else "/"
    return json.dumps(
        {
            "notification": {
                "title": title,
                "body": body or "",
                "icon": "/icon-192.png",
                "badge": "/badge-96.png",
                "lang": "en",
                # Later updates about the same order replace the earlier one on the device.
                "tag": f"order-{order_id}" if order_id else type,
                "renotify": bool(order_id),
                "timestamp": int(time.time() * 1000),
                "data": {
                    "type": type,
                    "url": path,
                    "onActionClick": {
                        "default": {"operation": "navigateLastFocusedOrOpen", "url": path}
                    },
                },
            }
        }
    )


def webpush_send(subscription: PushSubscription, payload: str, ttl: int, urgency: str) -> None:
    """One browser. Raises pywebpush.WebPushException (with `.response.status_code`)."""
    from pywebpush import webpush  # type: ignore[import-untyped]

    webpush(
        subscription_info={
            "endpoint": subscription.endpoint,
            "keys": {"p256dh": subscription.p256dh, "auth": subscription.auth},
        },
        data=payload,
        vapid_private_key=settings.VAPID_PRIVATE_KEY,
        vapid_claims={"sub": settings.VAPID_SUBJECT},
        ttl=ttl,
        headers={"Urgency": urgency},
        timeout=10,
    )


def push_to_subscriptions(subscriptions: list[PushSubscription], payload: str, urgent: bool) -> int:
    """Sends to each browser; forgets gone ones. Returns how many accepted it."""
    sent = 0
    send = _override.get("webpush") or webpush_send
    for sub in subscriptions:
        try:
            send(sub, payload, 60 * 60 if urgent else 24 * 60 * 60, "high" if urgent else "normal")
        except Exception as error:
            status = getattr(getattr(error, "response", None), "status_code", None)
            gone = status in (404, 410)
            if gone or sub.failures + 1 >= MAX_FAILURES:
                PushSubscription.objects.filter(pk=sub.pk).delete()
            else:
                PushSubscription.objects.filter(pk=sub.pk).update(failures=sub.failures + 1)
            if not gone:
                logger.warning("Web push failed", extra={"status": status})
            continue
        sent += 1
        PushSubscription.objects.filter(pk=sub.pk).update(
            failures=0, last_success_at=timezone.now()
        )
    return sent


def send_push(delivery: NotificationDelivery) -> None:
    n: Notification = delivery.notification
    subscriptions = list(PushSubscription.objects.filter(user_id=delivery.user_id))
    if not subscriptions:
        raise Skip("No subscribed browser")
    payload = push_payload(n.type, n.title, n.body, n.link, n.order_id)
    if not push_to_subscriptions(subscriptions, payload, content.category_of(n.type) == "orders"):
        if not PushSubscription.objects.filter(user_id=delivery.user_id).exists():
            raise Skip("Every browser unsubscribed")
        raise RuntimeError("No browser accepted the push")


# ---------------------------------------------------------------------------
# FCM (HTTP v1 with a service account; off until FCM_CREDENTIALS_FILE is set)
# ---------------------------------------------------------------------------
_fcm_token: dict[str, Any] = {}


def fcm_enabled() -> bool:
    return bool(_override.get(Channel.FCM)) or bool(settings.FCM_CREDENTIALS_FILE)


def _fcm_access_token(account: dict[str, Any]) -> str:
    if _fcm_token.get("expires", 0) > time.time() + 60:
        return str(_fcm_token["token"])
    now = int(time.time())
    assertion = jwt.encode(
        {
            "iss": account["client_email"],
            "scope": "https://www.googleapis.com/auth/firebase.messaging",
            "aud": account["token_uri"],
            "iat": now,
            "exp": now + 3600,
        },
        account["private_key"],
        algorithm="RS256",
    )
    res = requests.post(
        account["token_uri"],
        data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion},
        timeout=10,
    )
    res.raise_for_status()
    data = res.json()
    _fcm_token.update(token=data["access_token"], expires=now + int(data.get("expires_in", 3600)))
    return str(data["access_token"])


def send_fcm(delivery: NotificationDelivery) -> None:
    tokens = list(DeviceToken.objects.filter(user_id=delivery.user_id))
    if not tokens:
        raise Skip("No app installed")
    with open(settings.FCM_CREDENTIALS_FILE) as fh:
        account = json.load(fh)
    n = delivery.notification
    url = f"https://fcm.googleapis.com/v1/projects/{account['project_id']}/messages:send"
    headers = {"Authorization": f"Bearer {_fcm_access_token(account)}"}
    sent = 0
    for device in tokens:
        message: dict[str, Any] = {
            "message": {
                "token": device.token,
                "notification": {"title": n.title, "body": n.body},
                "data": {"type": n.type, "url": n.link or "/"},
            }
        }
        res = requests.post(url, json=message, headers=headers, timeout=10)
        if res.status_code in (400, 404) and "UNREGISTERED" in res.text:
            device.delete()  # the app was uninstalled
        elif res.ok:
            sent += 1
            DeviceToken.objects.filter(pk=device.pk).update(
                failures=0, last_success_at=timezone.now()
            )
        else:
            DeviceToken.objects.filter(pk=device.pk).update(failures=device.failures + 1)
    if not sent:
        raise RuntimeError("No device accepted the message")


# ---------------------------------------------------------------------------
# Email and SMS
# ---------------------------------------------------------------------------
def send_email(delivery: NotificationDelivery) -> None:
    user = delivery.user
    if not user.email:
        raise Skip("No email address")
    subject, text, html = content.render_email(delivery.notification, user.name)
    message = EmailMultiAlternatives(subject, text, to=[user.email])
    message.attach_alternative(html, "text/html")
    message.send()


sms_outbox: list[dict[str, str]] = []  # the "test" provider (tests only)


def sms_enabled() -> bool:
    if _override.get(Channel.SMS):
        return True
    if settings.SMS_PROVIDER == "msg91":
        return bool(settings.MSG91_AUTH_KEY)
    return settings.SMS_PROVIDER in ("console", "test")


def send_sms(delivery: NotificationDelivery) -> None:
    phone = delivery.user.phone
    if not phone:
        raise Skip("No phone number")
    deliver_sms(phone, content.render_sms(delivery.notification))


def deliver_sms(phone: str, text: str, template_id: str | None = None) -> None:
    """One SMS through the configured provider (notifications and sign-in codes)."""
    provider = settings.SMS_PROVIDER
    if provider == "test":
        sms_outbox.append({"to": phone, "text": text})
    elif provider == "console":
        # Development only: the text is shown so sign-in codes can be read from the log.
        logger.info("SMS to ...%s (console provider, not sent): %s", phone[-4:], text)
    elif provider == "msg91":
        res = requests.post(
            "https://control.msg91.com/api/v5/flow",
            json={
                "template_id": template_id or settings.MSG91_TEMPLATE_ID,
                "short_url": "0",
                "recipients": [{"mobiles": phone.lstrip("+"), "message": text}],
            },
            headers={"authkey": settings.MSG91_AUTH_KEY},
            timeout=10,
        )
        if res.status_code in (400, 401, 403):
            raise PermanentFailure(f"MSG91 refused the message ({res.status_code})")
        res.raise_for_status()
    else:
        raise Skip("SMS is off")


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------
SENDERS: dict[str, Sender] = {
    Channel.PUSH: send_push,
    Channel.FCM: send_fcm,
    Channel.EMAIL: send_email,
    Channel.SMS: send_sms,
}
_override: dict[str, Any] = {}


def sender_for(channel: str) -> Sender:
    return _override.get(channel) or SENDERS[channel]


def channel_enabled(channel: str) -> bool:
    if channel == Channel.PUSH:
        return push_enabled()
    if channel == Channel.FCM:
        return fcm_enabled()
    if channel == Channel.SMS:
        return sms_enabled()
    return settings.NOTIFICATION_EMAILS


@contextmanager
def use_sender(channel: str, fn: Any) -> Iterator[None]:
    """Tests: replace a channel's sender (or "webpush", the per-browser call)."""
    previous = _override.get(channel)
    _override[channel] = fn
    try:
        yield
    finally:
        if previous is None:
            _override.pop(channel, None)
        else:
            _override[channel] = previous
