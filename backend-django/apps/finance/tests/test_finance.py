"""
Phase 15 (commission, settlements and reports): the admin finance endpoints (Node parity), plus
commission rules, refund deductions, the ledger, invoices and statements, and partner history.
"""

from collections.abc import Callable
from typing import Any

import pytest
from django.db import DatabaseError, transaction
from rest_framework.test import APIClient

from apps.accounts.tests.test_auth import create_and_login
from apps.audit.models import AuditLog
from apps.finance.models import Invoice, LedgerEntry, OrderSettlement, Payout
from apps.notifications.models import Notification
from apps.orders.models import Order
from apps.orders.tests.test_orders import NEAR, World, client_for
from apps.restaurants.models import Restaurant

pytestmark = pytest.mark.django_db
Commits = Callable[..., Any]


@pytest.fixture
def w() -> World:
    return World()


def deliver(w: World, online: bool = False) -> str:
    """A delivered order of the seeded restaurant (cash, or paid with the simulated gateway)."""
    if online:
        w.add()
        order_id = str(w.place(paymentMethod="online").json()["data"]["order"]["id"])
        w.c.post(f"/api/v1/payments/orders/{order_id}/mock", {"outcome": "success"}, format="json")
        for status in ("confirmed", "preparing", "ready_for_pickup"):
            w.restaurant_set(order_id, status)
    else:
        order_id = w.ready_order()
    w.go_online(w.r, NEAR)
    if Order.objects.get(pk=order_id).status == "ready_for_pickup":
        assert w.accept(w.r, order_id).status_code == 200
    for status in ("picked_up", "on_the_way", "delivered"):
        assert w.rider_set(w.r, order_id, status).status_code == 200
    return order_id


def finance() -> APIClient:
    return client_for(create_and_login("finance_admin")["token"])


def balances() -> dict[str, int]:
    data = finance().get("/api/v1/admin/finance/ledger").json()["data"]
    assert data["balanced"] is True
    return {a["account"]: a["balancePaise"] for a in data["accounts"]}


# --- settlement, ledger ------------------------------------------------------------------------


def test_delivery_settles_the_order_and_posts_a_balanced_ledger_group(w: World) -> None:
    order = Order.objects.get(pk=deliver(w))
    s = OrderSettlement.objects.get(order=order)
    assert s.commission_bp == 1500
    assert s.restaurant_paise + s.rider_paise + s.platform_paise == order.total_paise
    b = balances()
    assert b["customer_payments"] == order.total_paise
    assert b["restaurant_payable"] == -s.restaurant_paise
    assert b["rider_payable"] == -s.rider_paise
    assert b["tax_payable"] == -order.tax_paise
    assert sum(b.values()) == 0
    # Ledger rows cannot be changed, even in SQL (database trigger).
    with pytest.raises(DatabaseError), transaction.atomic():
        LedgerEntry.objects.filter(order=order).update(amount_paise=0)


# --- commission rules ---------------------------------------------------------------------------


def test_commission_rules_global_and_per_restaurant(w: World) -> None:
    f = finance()
    rules = f.get("/api/v1/admin/finance/commission/rules").json()["data"]
    assert rules["global"]["basisPoints"] == 1500
    res = f.put(
        "/api/v1/admin/finance/commission/rules",
        {"basisPoints": 1200, "note": "Festival offer"},
        format="json",
    )
    assert res.status_code == 200, res.json()
    assert res.json()["data"]["global"]["percent"] == 12
    restaurant = Restaurant.objects.get(slug="spice-route-kitchen")
    f.put(
        "/api/v1/admin/finance/commission/rules",
        {"restaurantId": str(restaurant.pk), "basisPoints": 1000},
        format="json",
    )
    s = OrderSettlement.objects.get(order_id=deliver(w))
    assert s.commission_bp == 1000  # the restaurant's own rate wins
    data = f.get("/api/v1/admin/finance/commission/rules").json()["data"]
    assert [o["restaurant"]["name"] for o in data["overrides"]] == ["Spice Route Kitchen"]
    assert (
        len(data["history"]) == 2
    )  # 12% global and the 10% override (15% is the built-in default)
    assert f.delete(f"/api/v1/admin/finance/commission/rules/{restaurant.pk}").status_code == 200
    assert f.delete(f"/api/v1/admin/finance/commission/rules/{restaurant.pk}").status_code == 404
    assert AuditLog.objects.filter(action="commission.set").count() == 2
    too_high = f.put("/api/v1/admin/finance/commission/rules", {"basisPoints": 6000}, format="json")
    assert too_high.status_code == 422
    ops = client_for(create_and_login("operations_admin")["token"])
    assert ops.get("/api/v1/admin/finance/commission/rules").status_code == 403


# --- payouts ------------------------------------------------------------------------------------


def test_payouts_claim_due_settlements_once_and_notify_when_paid(
    w: World, django_capture_on_commit_callbacks: Commits
) -> None:
    order_id = deliver(w)
    s = OrderSettlement.objects.get(order_id=order_id)
    f = finance()
    due = f.get("/api/v1/admin/finance/payouts/due?type=restaurant").json()["data"]["items"]
    restaurant = Restaurant.objects.get(slug="spice-route-kitchen")
    assert due == [
        {
            "payeeId": str(restaurant.pk),
            "name": "Spice Route Kitchen",
            "orders": 1,
            "amountPaise": s.restaurant_paise,
            "from": due[0]["from"],
            "to": due[0]["to"],
        }
    ]
    body = {"type": "restaurant", "payeeId": str(restaurant.pk)}
    created = f.post("/api/v1/admin/finance/payouts", body, format="json")
    assert created.status_code == 201, created.json()
    payout = created.json()["data"]["payout"]
    assert (payout["orders"], payout["amountPaise"]) == (1, s.restaurant_paise)
    again = f.post("/api/v1/admin/finance/payouts", body, format="json")
    assert again.status_code == 400  # nothing left to pay

    with django_capture_on_commit_callbacks(execute=True):
        paid = f.post(
            f"/api/v1/admin/finance/payouts/{payout['id']}/paid",
            {"reference": "UTR123456"},
            format="json",
        )
    assert paid.json()["data"]["payout"]["status"] == "paid"
    assert Notification.objects.filter(user_id=w.owner["user"]["id"], type="payout.paid").exists()
    assert balances()["restaurant_payable"] == 0  # paid out in full
    assert f.post(f"/api/v1/admin/finance/payouts/{payout['id']}/cancel").status_code == 409
    assert AuditLog.objects.filter(action__in=["payout.create", "payout.paid"]).count() == 2

    # The rider's side, created then cancelled: the settlement is due again.
    rider_id = w.rider["user"]["id"]
    rp = f.post(
        "/api/v1/admin/finance/payouts", {"type": "rider", "payeeId": rider_id}, format="json"
    )
    cancelled = f.post(f"/api/v1/admin/finance/payouts/{rp.json()['data']['payout']['id']}/cancel")
    assert cancelled.json()["data"]["payout"]["status"] == "cancelled"
    rider_due = f.get("/api/v1/admin/finance/payouts/due?type=rider").json()["data"]["items"]
    assert rider_due[0]["amountPaise"] == s.rider_paise


# --- refund deductions ----------------------------------------------------------------------------


def test_a_refund_after_delivery_comes_off_the_restaurants_unpaid_share(
    w: World, django_capture_on_commit_callbacks: Commits
) -> None:
    order_id = deliver(w, online=True)
    s = OrderSettlement.objects.get(order_id=order_id)
    payment_id = Order.objects.get(pk=order_id).payment.pk
    f = finance()
    with django_capture_on_commit_callbacks(execute=True):
        res = f.post(
            f"/api/v1/admin/payments/{payment_id}/refunds",
            {"amountPaise": 5000, "reason": "Missing raita"},
            format="json",
        )
    assert res.status_code == 200, res.json()
    s.refresh_from_db()
    assert s.refund_adjustment_paise == 5000
    due = f.get("/api/v1/admin/finance/payouts/due?type=restaurant").json()["data"]["items"]
    assert due[0]["amountPaise"] == s.restaurant_paise - 5000
    b = balances()
    order = Order.objects.get(pk=order_id)
    assert b["customer_payments"] == order.total_paise - 5000
    assert b["restaurant_payable"] == -(s.restaurant_paise - 5000)


# --- invoices and statements ----------------------------------------------------------------------


def test_customers_download_an_invoice_once_the_order_is_delivered(w: World) -> None:
    pending = w.place_order()
    assert w.c.get(f"/api/v1/orders/{pending}/invoice").status_code == 409
    order_id = deliver(w)
    res = w.c.get(f"/api/v1/orders/{order_id}/invoice")
    assert res.status_code == 200
    assert res["Content-Type"] == "application/pdf"
    assert res.content.startswith(b"%PDF-1.4")
    assert res.content.rstrip().endswith(b"%%EOF")
    assert b"Tax invoice" in res.content
    assert b"Spice Route Kitchen" in res.content
    number = Invoice.objects.get(order_id=order_id).number
    assert number.startswith("BB/INV/20")
    assert number.endswith("/000001")
    w.c.get(f"/api/v1/orders/{order_id}/invoice")
    assert Invoice.objects.count() == 1  # the same number every time
    assert w.new_customer().get(f"/api/v1/orders/{order_id}/invoice").status_code == 404
    assert finance().get(f"/api/v1/admin/orders/{order_id}/invoice").status_code == 200


def test_partners_see_their_settlements_payouts_and_statements(w: World) -> None:
    order_id = deliver(w)
    f = finance()
    restaurant = Restaurant.objects.get(slug="spice-route-kitchen")
    payout = f.post(
        "/api/v1/admin/finance/payouts",
        {"type": "restaurant", "payeeId": str(restaurant.pk)},
        format="json",
    ).json()["data"]["payout"]

    history = w.o.get("/api/v1/my/restaurant/settlements").json()["data"]["items"]
    assert history[0]["orderId"] == order_id
    assert history[0]["commissionBp"] == 1500
    assert history[0]["payout"]["status"] == "pending"
    payouts = w.o.get("/api/v1/my/restaurant/payouts").json()["data"]["items"]
    assert [p["id"] for p in payouts] == [payout["id"]]
    statement = w.o.get(f"/api/v1/my/restaurant/payouts/{payout['id']}/statement")
    assert statement.status_code == 200
    assert statement.content.startswith(b"%PDF")
    assert b"Payout statement" in statement.content
    # A rider sees only their own deliveries and payouts.
    rider_history = w.r.get("/api/v1/delivery/settlements").json()["data"]["items"]
    assert (
        rider_history[0]["netPaise"] == OrderSettlement.objects.get(order_id=order_id).rider_paise
    )
    assert w.r.get(f"/api/v1/delivery/payouts/{payout['id']}/statement").status_code == 404
    assert w.c.get("/api/v1/my/restaurant/settlements").status_code == 403


# --- reports (Node parity) ------------------------------------------------------------------------


def test_finance_dashboard_transactions_refund_queue_commission_and_csv(w: World) -> None:
    order_id = deliver(w)
    f = finance()
    d = f.get("/api/v1/admin/finance/dashboard?days=7").json()["data"]
    order = Order.objects.get(pk=order_id)
    assert (
        d["totals"]["platformCommissionPaise"]
        == OrderSettlement.objects.get(order=order).platform_paise
    )
    assert len(d["daily"]) == 7
    t = f.get(f"/api/v1/admin/finance/transactions/{order.payment.pk}").json()["data"][
        "transaction"
    ]
    assert (t["order"]["orderNumber"], t["order"]["paidOut"]) == (
        order.order_number,
        {"restaurant": False, "rider": False},
    )
    assert t["order"]["settlement"]["commissionBp"] == 1500
    assert f.get("/api/v1/admin/finance/refunds?state=needed").json()["data"]["items"] == []
    report = f.get("/api/v1/admin/finance/commission").json()["data"]
    assert report["totals"]["orders"] == 1
    assert report["rates"]["restaurantCommissionPercent"] == 15
    csv = f.get("/api/v1/admin/finance/settlements.csv")
    assert csv["Content-Type"].startswith("text/csv")
    lines = csv.content.decode().strip().splitlines()
    assert lines[0].startswith("Order,Delivered at")
    assert lines[1].startswith(order.order_number)
    assert (
        client_for(create_and_login("support_admin")["token"])
        .get("/api/v1/admin/finance/dashboard")
        .status_code
        == 403
    )
    assert Payout.objects.count() == 0
