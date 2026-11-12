"""
Port of the Node API's tests/payments.test.js (simulated and Razorpay payments, webhooks,
refunds), plus Phase 12: partial and cash refunds, refund webhooks, reconciliation and the
customer's payment history.

Refunds reach the gateway after the database commit, so requests that open one run inside
`django_capture_on_commit_callbacks(execute=True)` (tests themselves run in one transaction).
"""

import contextlib
import hashlib
import hmac
import json
from collections.abc import Callable, Iterator
from datetime import timedelta
from typing import Any

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.tests.test_auth import create_and_login
from apps.audit.models import AuditLog
from apps.dispatch.config import DISPATCH
from apps.dispatch.services import sweep
from apps.notifications.models import Notification
from apps.orders.models import Order
from apps.orders.tests.test_orders import World, client_for
from apps.payments.models import Payment, Refund, WebhookEvent
from apps.payments.providers import RazorpayProvider, use_online_provider
from apps.payments.services import reconcile

pytestmark = pytest.mark.django_db

KEY_SECRET = "test_key_secret_0123456789"
WEBHOOK_SECRET = "test_webhook_secret_0123456789"
Commits = Callable[..., Any]


def sign(secret: str, data: str | bytes) -> str:
    raw = data.encode() if isinstance(data, str) else data
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


class FakeRazorpay:
    """Stands in for the Razorpay REST client: records refunds, answers lookups."""

    def __init__(self) -> None:
        self.payment: dict[str, Any] | None = None
        self.order_items: list[dict[str, Any]] = []
        self.refunds: list[tuple[str, int]] = []
        self.refund_state = "processed"
        self.fail_refunds = False

    def create_order(self, body: dict[str, Any]) -> dict[str, Any]:
        return {"id": "order_TEST123", "amount": body["amount"], "currency": "INR"}

    def fetch_payment(self, payment_id: str) -> dict[str, Any]:
        return {"id": payment_id, **(self.payment or {})}

    def order_payments(self, order_id: str) -> list[dict[str, Any]]:
        return self.order_items

    def refund(self, payment_id: str, body: dict[str, Any]) -> dict[str, Any]:
        if self.fail_refunds:
            raise OSError("gateway down")
        self.refunds.append((payment_id, body["amount"]))
        return {"id": f"rfnd_TEST{len(self.refunds)}", "status": self.refund_state}

    def fetch_refund(self, refund_id: str) -> dict[str, Any]:
        return {"id": refund_id, "status": "processed"}


class Shop(World):
    def place_online(self, client: APIClient | None = None) -> dict[str, Any]:
        self.add(client)
        res = self.place(client, paymentMethod="online")
        assert res.status_code == 201, res.json()
        data: dict[str, Any] = res.json()["data"]
        return data

    def mock_pay(self, order_id: str, outcome: str, client: APIClient | None = None) -> Any:
        return (client or self.c).post(
            f"/api/v1/payments/orders/{order_id}/mock", {"outcome": outcome}, format="json"
        )

    def restaurant_orders(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = self.o.get("/api/v1/my/restaurant/orders").json()["data"][
            "items"
        ]
        return items

    def payment(self, order_id: str) -> Payment:
        return Payment.objects.get(order_id=order_id)


@pytest.fixture
def w() -> Shop:
    return Shop()


@pytest.fixture
def gateway() -> Iterator[FakeRazorpay]:
    fake = FakeRazorpay()
    provider = RazorpayProvider("rzp_test_key", KEY_SECRET, WEBHOOK_SECRET, client=fake)
    with use_online_provider(provider):
        yield fake


def admin(role: str = "admin") -> APIClient:
    return client_for(create_and_login(role)["token"])


def after_window() -> Any:
    return timezone.now() + timedelta(minutes=DISPATCH["payment_window_minutes"] + 1)


# --- methods -----------------------------------------------------------------------------------


def test_offers_cash_and_the_simulated_online_payment_in_development(w: Shop) -> None:
    methods = APIClient().get("/api/v1/payments/methods").json()["data"]["methods"]
    assert [m["method"] for m in methods] == ["cod", "online"]
    assert methods[1]["provider"] == "mock"
    assert methods[1]["simulated"] is True  # clearly labelled as simulated


def test_cash_only_when_no_online_provider(w: Shop, settings: Any) -> None:
    settings.PAYMENTS_MOCK_ENABLED = False
    methods = APIClient().get("/api/v1/payments/methods").json()["data"]["methods"]
    assert [m["method"] for m in methods] == ["cod"]
    w.add()
    res = w.place(paymentMethod="online")
    assert res.status_code == 400
    assert res.json()["message"] == "Online payment is not available right now"


# --- simulated online payment ------------------------------------------------------------------


def test_keeps_the_order_from_the_restaurant_until_it_is_paid(w: Shop) -> None:
    placed = w.place_online()
    order_id, checkout = placed["order"]["id"], placed["checkout"]
    assert checkout["provider"] == "mock"
    assert checkout["providerOrderId"].startswith("mock_order_")
    assert checkout["amountPaise"] == placed["order"]["pricing"]["totalPaise"]
    assert w.restaurant_orders() == []  # unpaid: invisible to the restaurant
    assert w.restaurant_set(order_id, "confirmed").status_code == 404

    paid = w.mock_pay(order_id, "success")
    assert paid.json()["data"]["payment"]["status"] == "paid"
    saved = Order.objects.get(pk=order_id)
    assert saved.payment_status == "paid"
    assert saved.submitted_at
    assert w.restaurant_orders()[0]["id"] == order_id  # paid: the restaurant sees it
    owner = w.owner["user"]["id"]
    assert Notification.objects.filter(user_id=owner, type="order.new").count() == 1

    again = w.mock_pay(order_id, "success")
    assert again.json()["data"]["payment"]["status"] == "paid"  # repeating is harmless
    assert Notification.objects.filter(user_id=owner, type="order.new").count() == 1


def test_can_fail_and_be_retried(w: Shop) -> None:
    order_id = w.place_online()["order"]["id"]
    assert w.mock_pay(order_id, "failure").json()["data"]["payment"]["status"] == "failed"
    assert Order.objects.get(pk=order_id).submitted_at is None
    view = w.c.get(f"/api/v1/orders/{order_id}").json()["data"]["order"]
    assert view["payment"]["status"] == "failed"
    assert view["payment"]["failureReason"] == "Simulated failure"
    # "Pay now" again: the same gateway order is reused.
    restart = w.c.post(f"/api/v1/payments/orders/{order_id}/start")
    assert restart.status_code == 200
    assert (
        restart.json()["data"]["checkout"]["providerOrderId"]
        == w.payment(order_id).provider_order_id
    )
    assert w.mock_pay(order_id, "success").json()["data"]["payment"]["status"] == "paid"
    assert w.c.post(f"/api/v1/payments/orders/{order_id}/start").status_code == 409


def test_cancels_orders_that_are_never_paid(w: Shop) -> None:
    order_id = w.place_online()["order"]["id"]
    assert sweep(after_window())["unpaid_cancelled"] == 1
    saved = Order.objects.get(pk=order_id)
    assert saved.status == "cancelled"
    assert saved.cancellation.by == "system"
    assert w.payment(order_id).status == "cancelled"
    assert w.mock_pay(order_id, "success").status_code == 409  # too late to pay


def test_closing_the_payment_page_cancels_the_attempt_and_refills_the_cart(w: Shop) -> None:
    order_id = w.place_online()["order"]["id"]

    def abandon(oid: str) -> Any:
        return w.c.post(f"/api/v1/payments/orders/{oid}/abandon")

    res = abandon(order_id)
    assert res.status_code == 200, res.json()
    assert res.json()["data"]["restored"] is True
    assert Order.objects.get(pk=order_id).status == "cancelled"
    cart = w.c.get("/api/v1/cart").json()["data"]["cart"]
    assert cart["items"][0]["quantity"] == 2  # the dishes are back in the cart
    assert w.c.get("/api/v1/orders").json()["data"]["items"] == []  # never shown as an order
    assert abandon(order_id).json()["data"]["restored"] is False  # repeating is harmless
    assert not Notification.objects.filter(user_id=w.owner["user"]["id"]).exists()

    w.c.delete("/api/v1/cart")
    paid = w.place_online()["order"]["id"]
    w.mock_pay(paid, "success")
    late = abandon(paid)
    assert late.status_code == 409  # a paid order cannot be abandoned
    assert late.json()["error"]["code"] == "ORDER_PLACED"


def test_refunds_a_paid_order_the_restaurant_rejects(
    w: Shop, django_capture_on_commit_callbacks: Commits
) -> None:
    order_id = w.place_online()["order"]["id"]
    w.mock_pay(order_id, "success")
    with django_capture_on_commit_callbacks(execute=True):
        w.restaurant_set(order_id, "rejected", "Kitchen closed early")
    payment = w.payment(order_id)
    assert payment.status == "refunded"
    assert payment.refunded_paise == payment.amount_paise
    refund = payment.refunds.get()
    assert (refund.status, refund.provider_refund_id) == ("processed", f"mock_refund_{refund.pk}")
    assert Order.objects.get(pk=order_id).payment_status == "refunded"
    customer = w.customer["user"]["id"]
    assert Notification.objects.filter(user_id=customer, type="order.rejected").count() == 1
    assert Notification.objects.filter(user_id=customer, type="payment.refunded").count() == 1
    # The customer sees the refund on the order.
    view = w.c.get(f"/api/v1/orders/{order_id}").json()["data"]["order"]["payment"]
    assert view["refunds"][0]["status"] == "processed"
    assert view["refundedPaise"] == payment.amount_paise


def test_only_lets_the_orders_customer_pay(w: Shop) -> None:
    order_id = w.place_online()["order"]["id"]
    assert w.mock_pay(order_id, "success", w.new_customer()).status_code == 404
    assert w.mock_pay(order_id, "maybe").status_code == 422
    cod = w.place_order()  # cash: nothing to pay online
    assert w.mock_pay(cod, "success").json()["message"] == "This order is paid in cash on delivery"


# --- Razorpay (fake gateway client) ------------------------------------------------------------


def confirm(w: Shop, order_id: str, payment_id: str, signature: str) -> Any:
    return w.c.post(
        f"/api/v1/payments/orders/{order_id}/confirm",
        {"providerPaymentId": payment_id, "signature": signature},
        format="json",
    )


def webhook(event: str, entity: dict[str, Any], event_id: str, signature: str | None = None) -> Any:
    raw = json.dumps({"event": event, "payload": {event.split(".")[0]: {"entity": entity}}})
    return APIClient().post(
        "/api/v1/payments/webhooks/razorpay",
        data=raw,
        content_type="application/json",
        HTTP_X_RAZORPAY_SIGNATURE=signature or sign(WEBHOOK_SECRET, raw),
        HTTP_X_RAZORPAY_EVENT_ID=event_id,
    )


def test_verifies_the_signature_and_the_payment_before_marking_paid(
    w: Shop, gateway: FakeRazorpay
) -> None:
    placed = w.place_online()
    order_id, checkout = placed["order"]["id"], placed["checkout"]
    assert checkout["provider"] == "razorpay"
    assert checkout["keyId"] == "rzp_test_key"  # the public key only
    amount = checkout["amountPaise"]

    forged = confirm(w, order_id, "pay_TEST1", "0" * 64)
    assert forged.status_code == 400
    assert forged.json()["error"]["code"] == "SIGNATURE_INVALID"

    signature = sign(KEY_SECRET, "order_TEST123|pay_TEST1")
    gateway.payment = {"status": "captured", "amount": amount - 100, "order_id": "order_TEST123"}
    short = confirm(w, order_id, "pay_TEST1", signature)
    assert short.json()["error"]["code"] == "PAYMENT_MISMATCH"  # the amount must match

    gateway.payment = {"status": "captured", "amount": amount, "order_id": "order_TEST123"}
    done = confirm(w, order_id, "pay_TEST1", signature)
    assert done.json()["data"]["payment"]["status"] == "paid"
    assert Order.objects.get(pk=order_id).submitted_at
    assert w.mock_pay(order_id, "success").status_code == 400  # not a simulated payment


def test_accepts_signed_webhooks_once_and_rejects_unsigned_ones(
    w: Shop, gateway: FakeRazorpay
) -> None:
    placed = w.place_online()
    entity = {
        "id": "pay_TEST2",
        "order_id": "order_TEST123",
        "amount": placed["checkout"]["amountPaise"],
        "email": "someone@example.test",
    }
    assert webhook("payment.captured", entity, "evt_1", signature="bad").status_code == 400
    first = webhook("payment.captured", entity, "evt_1")
    assert first.json()["data"]["processed"] is True
    assert w.payment(placed["order"]["id"]).status == "paid"
    replay = webhook("payment.captured", entity, "evt_1")
    assert replay.json()["data"]["duplicate"] is True  # the same event id is ignored
    stored = WebhookEvent.objects.get(event_id="evt_1")
    assert "email" not in stored.payload  # no personal details kept


def test_a_failed_webhook_leaves_the_event_for_the_retry(
    w: Shop, gateway: FakeRazorpay, monkeypatch: pytest.MonkeyPatch
) -> None:
    placed = w.place_online()
    entity = {
        "id": "pay_T",
        "order_id": "order_TEST123",
        "amount": placed["checkout"]["amountPaise"],
    }

    def broken(*args: Any) -> Any:
        raise RuntimeError("database hiccup")

    monkeypatch.setattr("apps.payments.services.mark_paid", broken)
    with contextlib.suppress(RuntimeError):  # the test client re-raises unhandled errors
        assert webhook("payment.captured", entity, "evt_retry").status_code == 500
    assert not WebhookEvent.objects.filter(event_id="evt_retry").exists()
    monkeypatch.undo()
    assert webhook("payment.captured", entity, "evt_retry").json()["data"]["processed"] is True
    assert w.payment(placed["order"]["id"]).status == "paid"


def test_refunds_a_payment_that_arrives_after_the_order_expired(
    w: Shop, gateway: FakeRazorpay, django_capture_on_commit_callbacks: Commits
) -> None:
    placed = w.place_online()
    order_id, amount = placed["order"]["id"], placed["checkout"]["amountPaise"]
    sweep(after_window())
    entity = {"id": "pay_LATE", "order_id": "order_TEST123", "amount": amount}
    with django_capture_on_commit_callbacks(execute=True):
        webhook("payment.captured", entity, "evt_late")
    assert gateway.refunds == [("pay_LATE", amount)]  # the money goes back
    assert w.payment(order_id).status == "refunded"
    assert Order.objects.get(pk=order_id).status == "cancelled"  # the order stays cancelled


def test_refunds_through_the_gateway_when_a_paid_order_is_cancelled(
    w: Shop, gateway: FakeRazorpay, django_capture_on_commit_callbacks: Commits
) -> None:
    placed = w.place_online()
    order_id, amount = placed["order"]["id"], placed["checkout"]["amountPaise"]
    gateway.payment = {"status": "captured", "amount": amount, "order_id": "order_TEST123"}
    confirm(w, order_id, "pay_TEST3", sign(KEY_SECRET, "order_TEST123|pay_TEST3"))
    with django_capture_on_commit_callbacks(execute=True):
        res = admin().post(
            f"/api/v1/admin/orders/{order_id}/cancel", {"reason": "Customer request"}, format="json"
        )
    assert res.status_code == 200
    assert gateway.refunds == [("pay_TEST3", amount)]
    assert w.payment(order_id).status == "refunded"


# --- failed refunds, partial and cash refunds --------------------------------------------------


def paid_razorpay_order(w: Shop, gateway: FakeRazorpay, payment_id: str = "pay_P") -> str:
    placed = w.place_online()
    order_id, amount = placed["order"]["id"], placed["checkout"]["amountPaise"]
    gateway.payment = {"status": "captured", "amount": amount, "order_id": "order_TEST123"}
    res = confirm(w, order_id, payment_id, sign(KEY_SECRET, f"order_TEST123|{payment_id}"))
    assert res.json()["data"]["payment"]["status"] == "paid"
    return str(order_id)


def test_a_failed_refund_is_reported_and_can_be_retried(
    w: Shop, gateway: FakeRazorpay, django_capture_on_commit_callbacks: Commits
) -> None:
    order_id = paid_razorpay_order(w, gateway)
    payment = w.payment(order_id)
    gateway.fail_refunds = True
    with django_capture_on_commit_callbacks(execute=True):
        w.restaurant_set(order_id, "rejected", "Out of stock")
    payment.refresh_from_db()
    assert (payment.status, payment.refunded_paise) == ("paid", 0)  # nothing reserved any more
    assert payment.refunds.get().status == "failed"
    assert Notification.objects.filter(type="payment.refund_failed").exists()

    finance = admin("finance_admin")
    row = finance.get("/api/v1/admin/payments").json()["data"]["items"][0]
    assert (row["refundNeeded"], row["failureReason"]) == (
        True,
        "Refund failed; retry from the admin panel",
    )
    gateway.fail_refunds = False
    with django_capture_on_commit_callbacks(execute=True):
        retry = finance.post(f"/api/v1/admin/payments/{payment.pk}/refund")
    assert retry.status_code == 200, retry.json()
    assert retry.json()["message"] == "Refund issued"
    payment.refresh_from_db()
    assert payment.status == "refunded"
    assert payment.refunds.get().status == "processed"  # the same refund, sent again
    assert gateway.refunds == [("pay_P", payment.amount_paise)]
    assert AuditLog.objects.filter(action="payment.refund").exists()
    assert finance.post(f"/api/v1/admin/payments/{payment.pk}/refund").status_code == 409


def test_finance_refunds_part_of_a_delivered_order(
    w: Shop, gateway: FakeRazorpay, django_capture_on_commit_callbacks: Commits
) -> None:
    order_id = paid_razorpay_order(w, gateway)
    payment = w.payment(order_id)
    finance = admin("finance_admin")
    url = f"/api/v1/admin/payments/{payment.pk}/refunds"

    with django_capture_on_commit_callbacks(execute=True):
        part = finance.post(
            url,
            {"amountPaise": 5000, "reason": "Missing raita"},
            format="json",
            HTTP_IDEMPOTENCY_KEY="refund-key-1",
        )
    assert part.status_code == 200, part.json()
    assert part.json()["message"] == "Refund started"
    # (In production the gateway call runs at commit, before the response is built.)
    data = finance.get(f"/api/v1/admin/payments/{payment.pk}").json()["data"]["payment"]
    assert (data["status"], data["refundedPaise"]) == ("partially_refunded", 5000)
    assert data["refundablePaise"] == payment.amount_paise - 5000
    assert data["refunds"][0]["reason"] == "Missing raita"
    assert gateway.refunds == [("pay_P", 5000)]
    assert Order.objects.get(pk=order_id).payment_status == "partially_refunded"

    # A retried request (same key) does not refund twice.
    with django_capture_on_commit_callbacks(execute=True):
        finance.post(
            url,
            {"amountPaise": 5000, "reason": "Missing raita"},
            format="json",
            HTTP_IDEMPOTENCY_KEY="refund-key-1",
        )
    assert len(gateway.refunds) == 1

    too_much = finance.post(url, {"amountPaise": payment.amount_paise}, format="json")
    assert too_much.status_code == 422
    with django_capture_on_commit_callbacks(execute=True):
        too_much = finance.post(
            url, {"amountPaise": payment.amount_paise, "reason": "All of it"}, format="json"
        )
    assert too_much.status_code == 422
    assert too_much.json()["error"]["details"][0]["field"] == "amountPaise"

    with django_capture_on_commit_callbacks(execute=True):
        rest = finance.post(
            url,
            {"amountPaise": payment.amount_paise - 5000, "reason": "Order arrived cold"},
            format="json",
        )
    assert rest.status_code == 200
    assert w.payment(order_id).status == "refunded"
    assert AuditLog.objects.filter(action="payment.partial_refund").count() == 3
    support = admin("support_admin")  # no refunds:manage
    assert support.post(url, {"amountPaise": 100, "reason": "x"}, format="json").status_code == 403


def test_cash_refunds_wait_for_finance_to_pay_them(
    w: Shop, django_capture_on_commit_callbacks: Commits
) -> None:
    w.go_online(w.r)
    order_id = w.ready_order()
    w.accept(w.r, order_id)
    for status in ("picked_up", "on_the_way", "delivered"):
        assert w.rider_set(w.r, order_id, status).status_code == 200
    payment = w.payment(order_id)
    assert payment.status == "paid"
    finance = admin("finance_admin")
    with django_capture_on_commit_callbacks(execute=True):
        res = finance.post(
            f"/api/v1/admin/payments/{payment.pk}/refunds",
            {"amountPaise": 2000, "reason": "Wrong dish"},
            format="json",
        )
    refund = res.json()["data"]["payment"]["refunds"][0]
    assert refund["status"] == "manual_pending"
    assert res.json()["data"]["payment"]["status"] == "paid"
    done = finance.post(f"/api/v1/admin/refunds/{refund['id']}/paid")
    assert done.status_code == 200
    assert done.json()["data"]["payment"]["status"] == "partially_refunded"
    assert finance.post(f"/api/v1/admin/refunds/{refund['id']}/paid").status_code == 409


def test_refund_webhooks_settle_refunds_the_bank_confirms_later(
    w: Shop, gateway: FakeRazorpay, django_capture_on_commit_callbacks: Commits
) -> None:
    order_id = paid_razorpay_order(w, gateway)
    gateway.refund_state = "pending"
    with django_capture_on_commit_callbacks(execute=True):
        w.restaurant_set(order_id, "rejected", "Closed")
    refund = Refund.objects.get()
    assert refund.status == "processing"
    assert w.payment(order_id).status == "paid"
    entity = {"id": refund.provider_refund_id, "payment_id": "pay_P", "amount": 1}
    assert webhook("refund.processed", entity, "evt_r1").json()["data"]["processed"] is True
    assert Refund.objects.get().status == "processed"
    assert w.payment(order_id).status == "refunded"
    assert webhook("refund.processed", entity, "evt_r1").json()["data"]["duplicate"] is True


# --- reconciliation ----------------------------------------------------------------------------


def test_reconciliation_catches_payments_and_refunds_that_were_missed(
    w: Shop, gateway: FakeRazorpay, django_capture_on_commit_callbacks: Commits
) -> None:
    placed = w.place_online()
    order_id, amount = placed["order"]["id"], placed["checkout"]["amountPaise"]
    later = timezone.now() + timedelta(minutes=3)
    assert reconcile(later)["paid"] == 0  # nothing paid at the gateway yet
    gateway.order_items = [{"id": "pay_LOST", "status": "captured", "amount": amount}]
    with django_capture_on_commit_callbacks(execute=True):
        assert reconcile(later)["paid"] == 1  # the browser closed and the webhook was lost
    assert Order.objects.get(pk=order_id).submitted_at
    assert reconcile(later)["paid"] == 0

    # A refund whose gateway call never happened (the process stopped after commit).
    gateway.refund_state = "pending"
    w.restaurant_set(order_id, "rejected", "Closed")  # on-commit work not run
    refund = Refund.objects.get()
    assert refund.status == "pending"
    summary = reconcile(timezone.now() + timedelta(minutes=3))
    assert summary["refunds_sent"] == 1
    assert Refund.objects.get().status == "processing"
    # The bank confirms it later.
    summary = reconcile(timezone.now() + timedelta(minutes=10))
    assert summary["refunds_settled"] == 1
    assert w.payment(order_id).status == "refunded"


# --- history and admin views -------------------------------------------------------------------


def test_the_customers_payment_history(w: Shop) -> None:
    paid = w.place_online()["order"]["id"]
    w.mock_pay(paid, "success")
    w.place_order()  # cash
    abandoned = w.place_online()["order"]["id"]
    w.c.post(f"/api/v1/payments/orders/{abandoned}/abandon")
    items = w.c.get("/api/v1/payments/mine").json()["data"]["items"]
    assert [i["method"] for i in items] == ["cod", "online"]  # the abandoned attempt is left out
    assert items[1]["order"]["restaurantName"] == "Spice Route Kitchen"
    assert w.o.get("/api/v1/payments/mine").status_code == 403


def test_admins_list_filter_and_open_payments(w: Shop) -> None:
    paid = w.place_online()["order"]["id"]
    w.mock_pay(paid, "success")
    w.place_order()
    finance = admin("finance_admin")
    everything = finance.get("/api/v1/admin/payments").json()["data"]
    assert everything["pagination"]["total"] == 2
    online = finance.get("/api/v1/admin/payments?method=online").json()["data"]["items"]
    assert [p["provider"] for p in online] == ["mock"]
    number = Order.objects.get(pk=paid).order_number
    found = finance.get(f"/api/v1/admin/payments?search={number}").json()["data"]["items"]
    assert [p["order"]["id"] for p in found] == [paid]
    assert finance.get("/api/v1/admin/payments?status=nope").status_code == 422
    detail = finance.get(f"/api/v1/admin/payments/{online[0]['id']}").json()["data"]["payment"]
    assert detail["customer"]["id"] == w.customer["user"]["id"]
    assert detail["refunds"] == []
    assert admin("support_admin").get("/api/v1/admin/payments").status_code == 403


def test_two_refunds_can_never_return_more_than_was_paid(w: Shop) -> None:
    from apps.payments.services import _open_refund
    from common.api import ApiError

    order_id = w.place_online()["order"]["id"]
    w.mock_pay(order_id, "success")
    payment = w.payment(order_id)
    most = payment.amount_paise - 100
    # Both passed the up-front check; the reservation (a conditional update) lets one through.
    _open_refund(payment, most, key="race-a", reason="a")
    with pytest.raises(ApiError) as lost:
        _open_refund(payment, most, key="race-b", reason="b")
    assert lost.value.code == "REFUND_TOO_LARGE"
    assert Payment.objects.get(pk=payment.pk).refunded_paise == most
