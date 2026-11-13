"""
Phase 14 (notifications and background jobs): the inbox and Web Push (port of the Node API's
notification and push tests), plus channels (push, email, SMS, FCM), per-channel preferences,
the delivery log with retries and dead letters, and the new events.

Deliveries are sent after commit, so actions that notify run inside
`django_capture_on_commit_callbacks(execute=True)`. No test reaches a real provider: senders are
swapped (`use_sender`), email uses the locmem backend and SMS the "test" provider.
"""

from collections.abc import Callable, Iterator
from datetime import timedelta
from typing import Any

import pytest
from django.core import mail
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.accounts.tests.test_auth import create_and_login, register, token_of
from apps.audit.models import AuditLog
from apps.notifications import senders, services
from apps.notifications.models import (
    DeliveryStatus,
    DeviceToken,
    Notification,
    NotificationDelivery,
    PushSubscription,
)
from apps.orders.tests.test_orders import client_for

pytestmark = pytest.mark.django_db
Commits = Callable[..., Any]
ENDPOINT = "https://fcm.googleapis.com/fcm/send/abcdefghijklmnopqrstuvwxyz123456"
KEYS = {"p256dh": "B" + "A" * 86, "auth": "C" * 22}


class FakeWebPush:
    """Records pushes; `status` makes every send fail with that HTTP status."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []
        self.status: int | None = None

    def __call__(self, sub: PushSubscription, payload: str, ttl: int, urgency: str) -> None:
        if self.status:
            error = RuntimeError(f"push service said {self.status}")
            error.response = type("R", (), {"status_code": self.status})()  # type: ignore[attr-defined]
            raise error
        self.sent.append((sub.endpoint, payload))


@pytest.fixture
def push(settings: Any) -> Iterator[FakeWebPush]:
    settings.VAPID_PUBLIC_KEY = "test-public-key"
    settings.VAPID_PRIVATE_KEY = "test-private-key"
    fake = FakeWebPush()
    with senders.use_sender("webpush", fake):
        yield fake


@pytest.fixture
def customer() -> dict[str, Any]:
    return create_and_login("customer")


def subscribe(client: APIClient, endpoint: str = ENDPOINT) -> Any:
    return client.post(
        "/api/v1/push/subscriptions",
        {"endpoint": endpoint, "keys": KEYS},
        format="json",
        HTTP_USER_AGENT="Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile",
    )


def deliveries(user_id: str) -> dict[str, str]:
    return dict(
        NotificationDelivery.objects.filter(user_id=user_id).values_list("channel", "status")
    )


# --- inbox (Node parity) -----------------------------------------------------------------------


def test_the_inbox_lists_marks_read_and_clears(customer: dict[str, Any]) -> None:
    user_id = customer["user"]["id"]
    for n in range(3):
        services.notify(user_id, type="order.confirmed", title=f"Order {n} accepted")
    c = client_for(customer["token"])
    page = c.get("/api/v1/notifications?limit=2").json()["data"]
    assert (len(page["items"]), page["unread"], page["pagination"]["total"]) == (2, 3, 3)
    first = page["items"][0]
    assert first["title"] == "Order 2 accepted"  # newest first
    assert set(first) >= {"id", "type", "title", "readAt", "createdAt"}

    read = c.patch(f"/api/v1/notifications/{first['id']}/read")
    assert read.json()["data"]["notification"]["readAt"]
    unread = c.get("/api/v1/notifications?unread=true").json()["data"]
    assert (len(unread["items"]), unread["unread"]) == (2, 2)
    assert c.post("/api/v1/notifications/read-all").json()["data"] == {"updated": 2}
    stranger = client_for(create_and_login("restaurant")["token"])
    assert stranger.patch(f"/api/v1/notifications/{first['id']}/read").status_code == 404
    cleared = c.delete("/api/v1/notifications")
    assert (cleared.json()["message"], cleared.json()["data"]) == (
        "Notifications cleared",
        {"deleted": 3},
    )
    assert APIClient().get("/api/v1/notifications").status_code == 401


# --- Web Push subscriptions and preferences (Node parity) --------------------------------------


def test_push_is_off_until_vapid_keys_are_set(customer: dict[str, Any]) -> None:
    assert APIClient().get("/api/v1/push/public-key").json()["data"] == {
        "enabled": False,
        "publicKey": None,
    }
    res = subscribe(client_for(customer["token"]))
    assert res.status_code == 503
    assert res.json()["error"]["code"] == "PUSH_UNAVAILABLE"


def test_subscribing_a_browser_and_choosing_categories(
    push: FakeWebPush, customer: dict[str, Any]
) -> None:
    c = client_for(customer["token"])
    assert (
        APIClient().get("/api/v1/push/public-key").json()["data"]["publicKey"] == "test-public-key"
    )
    bad = subscribe(c, "https://evil.example.com/push/abcdefghijklmnopqrst")
    assert bad.status_code == 422
    assert bad.json()["error"]["code"] == "PUSH_ENDPOINT_NOT_ALLOWED"
    res = subscribe(c)
    assert res.status_code == 201, res.json()
    assert res.json()["data"]["subscription"]["device"] == "Chrome on Android"
    assert "keys" not in res.json()["data"]["subscription"]
    assert subscribe(c).status_code == 201  # again: updated, not duplicated
    assert PushSubscription.objects.count() == 1

    prefs = c.get("/api/v1/push/preferences").json()["data"]
    assert prefs["preferences"] == {"orders": True, "account": True, "promotions": False}
    assert (prefs["devices"], prefs["enabled"]) == (1, True)
    assert prefs["categories"] == ["orders", "account", "promotions"]
    saved = c.put("/api/v1/push/preferences", {"promotions": True}, format="json")
    assert saved.json()["data"]["preferences"]["promotions"] is True
    assert c.put("/api/v1/push/preferences", {"orders": "yes"}, format="json").status_code == 422

    gone = c.delete("/api/v1/push/subscriptions", {"endpoint": ENDPOINT}, format="json")
    assert gone.json()["data"] == {"removed": True}


# --- deliveries ------------------------------------------------------------------------------


def test_a_notification_goes_to_each_allowed_channel(
    push: FakeWebPush,
    customer: dict[str, Any],
    settings: Any,
    django_capture_on_commit_callbacks: Commits,
) -> None:
    settings.SMS_PROVIDER = "test"
    senders.sms_outbox.clear()
    user_id = customer["user"]["id"]
    subscribe(client_for(customer["token"]))
    with django_capture_on_commit_callbacks(execute=True):
        services.notify(user_id, type="order.placed", title="Order BB-1 placed", link="/orders/1")
    # Push and email (a receipt type, allowed by default); SMS is opt-in and order.placed has none.
    assert deliveries(user_id) == {"push": "sent", "email": "sent"}
    assert len(push.sent) == 1
    assert mail.outbox[-1].subject == "Order BB-1 placed | BiteBox"
    assert "http://localhost:4200/orders/1" in mail.outbox[-1].body
    assert "Open BiteBox" in mail.outbox[-1].alternatives[0][0]

    # The customer turns on SMS for orders: the delivery code goes by SMS too.
    c = client_for(customer["token"])
    res = c.put("/api/v1/notifications/preferences", {"sms": {"orders": True}}, format="json")
    assert res.json()["data"]["channels"]["sms"]["orders"] is True
    User.objects.filter(pk=user_id).update(phone="+919000000002")
    with django_capture_on_commit_callbacks(execute=True):
        services.notify(user_id, type="order.picked_up", title="Order picked up", body="Code 1234")
    assert senders.sms_outbox[-1]["text"] == "BiteBox: Order picked up. Code 1234"

    # Turning push off for orders stops it (the inbox row is still written).
    c.put("/api/v1/notifications/preferences", {"push": {"orders": False}}, format="json")
    before = len(push.sent)
    with django_capture_on_commit_callbacks(execute=True):
        services.notify(user_id, type="order.delivered", title="Delivered")
    assert len(push.sent) == before
    assert Notification.objects.filter(user_id=user_id, type="order.delivered").exists()


def test_promotions_reach_only_customers_who_opted_in(
    push: FakeWebPush, customer: dict[str, Any], django_capture_on_commit_callbacks: Commits
) -> None:
    c = client_for(customer["token"])
    subscribe(c)
    owner = create_and_login("restaurant")
    subscribe(client_for(owner["token"]), ENDPOINT + "owner")
    User.objects.filter(pk=owner["user"]["id"]).update(push_promotions=True)
    admin = client_for(create_and_login("admin")["token"])
    body = {"title": "Weekend offer", "body": "20% off biryani", "link": "/restaurants"}
    with django_capture_on_commit_callbacks(execute=True):
        assert admin.post("/api/v1/admin/push/promotions", body, format="json").json()["data"] == {
            "recipients": 0
        }  # nobody opted in yet
    c.put("/api/v1/push/preferences", {"promotions": True}, format="json")
    with django_capture_on_commit_callbacks(execute=True):
        res = admin.post("/api/v1/admin/push/promotions", body, format="json")
    assert res.json()["data"] == {"recipients": 1}  # the customer; never the partner
    assert len(push.sent) == 1
    assert '"Weekend offer"' in push.sent[0][1]
    assert AuditLog.objects.filter(action="push.promotion").count() == 2
    assert (
        admin.post(
            "/api/v1/admin/push/promotions", {**body, "link": "https://x.y"}, format="json"
        ).status_code
        == 422
    )
    support = client_for(create_and_login("support_admin")["token"])
    assert support.post("/api/v1/admin/push/promotions", body, format="json").status_code == 403


def test_failures_are_retried_with_back_off_then_dead_lettered(
    customer: dict[str, Any], django_capture_on_commit_callbacks: Commits
) -> None:
    user_id = customer["user"]["id"]
    calls: list[str] = []

    def flaky(delivery: NotificationDelivery) -> None:
        calls.append(delivery.channel)
        raise ConnectionError("SMTP timed out")

    with senders.use_sender("email", flaky), django_capture_on_commit_callbacks(execute=True):
        services.notify(user_id, type="payment.refunded", title="Refund processed")
    d = NotificationDelivery.objects.get(user_id=user_id, channel="email")
    assert (d.status, d.attempts) == ("failed", 1)
    assert "SMTP timed out" in d.last_error
    assert d.next_attempt_at
    assert d.next_attempt_at > timezone.now()
    assert services.attempt(d.pk) is None  # not due yet

    later = timezone.now()
    with senders.use_sender("email", flaky):
        for _ in range(services.MAX_ATTEMPTS - 1):
            later += timedelta(hours=2)
            services.attempt(d.pk, later)
    d.refresh_from_db()
    assert (d.status, d.attempts, d.next_attempt_at) == ("dead", services.MAX_ATTEMPTS, None)
    assert len(calls) == services.MAX_ATTEMPTS

    # Operations see the dead letter and send it again once the problem is fixed.
    ops = client_for(create_and_login("operations_admin")["token"])
    log = ops.get("/api/v1/admin/notifications/deliveries?status=dead").json()["data"]
    assert [i["id"] for i in log["items"]] == [str(d.pk)]
    assert log["counts"]["dead"] == 1
    with django_capture_on_commit_callbacks(execute=True):
        retried = ops.post(f"/api/v1/admin/notifications/deliveries/{d.pk}/retry")
    assert retried.status_code == 200, retried.json()
    d.refresh_from_db()
    assert d.status == "sent"
    assert ops.post(f"/api/v1/admin/notifications/deliveries/{d.pk}/retry").status_code == 409
    assert (
        client_for(customer["token"]).get("/api/v1/admin/notifications/deliveries").status_code
        == 403
    )


def test_the_retry_sweep_requeues_due_deliveries(customer: dict[str, Any]) -> None:
    user_id = customer["user"]["id"]
    services.notify(user_id, type="order.delivered", title="Delivered")  # never sent (no commit)
    d = NotificationDelivery.objects.get(user_id=user_id, channel="email")
    assert d.status == "queued"
    queued: list[str] = []
    from apps.notifications import tasks

    original = tasks.deliver.delay
    tasks.deliver.delay = lambda delivery_id: queued.append(delivery_id)  # type: ignore[method-assign]
    try:
        assert services.retry_due(timezone.now()) == 0  # just created: give the worker a chance
        assert services.retry_due(timezone.now() + timedelta(minutes=3)) == 1
    finally:
        tasks.deliver.delay = original  # type: ignore[method-assign]
    assert queued == [str(d.pk)]


def test_gone_browsers_are_forgotten_and_the_push_skipped(
    push: FakeWebPush, customer: dict[str, Any], django_capture_on_commit_callbacks: Commits
) -> None:
    subscribe(client_for(customer["token"]))
    push.status = 410
    with django_capture_on_commit_callbacks(execute=True):
        services.notify(customer["user"]["id"], type="order.confirmed", title="Accepted")
    assert deliveries(customer["user"]["id"])["push"] == DeliveryStatus.SKIPPED
    assert not PushSubscription.objects.exists()


def test_fcm_devices_and_sender(
    settings: Any, customer: dict[str, Any], django_capture_on_commit_callbacks: Commits
) -> None:
    c = client_for(customer["token"])
    token = "fcm-token-" + "x" * 40
    assert (
        c.post(
            "/api/v1/push/devices", {"token": token, "platform": "android"}, format="json"
        ).status_code
        == 201
    )
    assert DeviceToken.objects.filter(user_id=customer["user"]["id"]).count() == 1
    sent: list[str] = []
    settings.FCM_CREDENTIALS_FILE = "/not/used/in/tests.json"
    with (
        senders.use_sender("fcm", lambda d: sent.append(d.notification.title)),
        django_capture_on_commit_callbacks(execute=True),
    ):
        services.notify(customer["user"]["id"], type="order.confirmed", title="Accepted")
    assert sent == ["Accepted"]
    assert c.delete("/api/v1/push/devices", {"token": token}, format="json").json()["data"] == {
        "removed": True
    }


def test_old_notifications_are_purged(customer: dict[str, Any]) -> None:
    services.notify(customer["user"]["id"], type="order.confirmed", title="Old")
    Notification.objects.update(created_at=timezone.now() - timedelta(days=91))
    services.notify(customer["user"]["id"], type="order.confirmed", title="New")
    assert services.purge() == 1
    assert list(Notification.objects.values_list("title", flat=True)) == ["New"]


# --- new events ------------------------------------------------------------------------------


def test_a_welcome_note_on_sign_up(django_capture_on_commit_callbacks: Commits) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        res, body = register(APIClient(), name="Meera Rao")
    assert res.status_code == 201
    note = Notification.objects.get(type="account.welcome")
    assert note.title == "Welcome to BiteBox, Meera Rao!"
    assert mail.outbox[-1].to == [body["email"]]
    inbox = client_for(token_of(res)).get("/api/v1/notifications").json()["data"]
    assert inbox["unread"] == 1


def test_channel_preferences_show_what_is_available(customer: dict[str, Any]) -> None:
    c = client_for(customer["token"])
    data = c.get("/api/v1/notifications/preferences").json()["data"]
    assert data["channels"]["email"] == {"orders": True, "account": True, "promotions": False}
    assert data["channels"]["sms"] == {"orders": False, "account": False, "promotions": False}
    assert data["available"] == {"push": False, "email": True, "sms": False}
    assert (
        c.put(
            "/api/v1/notifications/preferences", {"email": {"orders": "no"}}, format="json"
        ).status_code
        == 422
    )
    partner = client_for(create_and_login("restaurant")["token"])
    assert partner.get("/api/v1/notifications/preferences").json()["data"]["categories"] == [
        "orders",
        "account",
    ]


def test_payment_failure_refund_start_and_rider_approaching(
    django_capture_on_commit_callbacks: Commits,
) -> None:
    from apps.orders.models import Order
    from apps.orders.tests.test_orders import NEAR, World

    w = World()
    customer_id = w.customer["user"]["id"]

    # A failed online payment, then a paid one the restaurant rejects (refund started).
    w.add()
    failed = w.place(paymentMethod="online").json()["data"]["order"]["id"]
    w.c.post(f"/api/v1/payments/orders/{failed}/mock", {"outcome": "failure"}, format="json")
    assert Notification.objects.filter(user_id=customer_id, type="payment.failed").exists()
    w.c.post(f"/api/v1/payments/orders/{failed}/mock", {"outcome": "success"}, format="json")
    with django_capture_on_commit_callbacks(execute=True):
        w.restaurant_set(failed, "rejected", "Closed early")
    started = Notification.objects.get(user_id=customer_id, type="payment.refund_started")
    assert started.title.startswith("Refund of ₹")

    # The rider on the way comes within 500 m of the customer: told once.
    w.go_online(w.r, NEAR)
    order_id = w.ready_order()
    w.accept(w.r, order_id)
    for status in ("picked_up", "on_the_way"):
        w.rider_set(w.r, order_id, status)
    move = lambda lat, lng: w.r.put(  # noqa: E731
        "/api/v1/delivery/me/location", {"latitude": lat, "longitude": lng}, format="json"
    )
    move(12.9600, 77.6350)  # ~3 km away
    assert not Notification.objects.filter(type="order.approaching").exists()
    move(12.9370, 77.6280)  # ~220 m from the delivery address
    move(12.9360, 77.6275)
    notes = Notification.objects.filter(user_id=customer_id, type="order.approaching")
    assert notes.count() == 1
    assert Order.objects.get(pk=order_id).delivery_otp in notes.get().body
