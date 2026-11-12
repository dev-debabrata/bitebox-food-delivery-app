"""
Phase 10 (admin dashboard): the operations views and reports (port of "shows the operations
dashboard and delivery performance" and the permission matrix in the Node API's
tests/admin-roles.test.js, and the report part of tests/payments.test.js), plus the platform
summary and login history added from the master prompt §3D.
"""

from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.tests.test_auth import cookie_of, create_and_login, login, refresh_with
from apps.finance.models import OrderSettlement
from apps.orders.models import Order
from apps.orders.tests.test_orders import World, client_for
from apps.reviews.tests.test_restaurant_reviews import delivered_order

pytestmark = pytest.mark.django_db
PASSWORD = "Sup3rSecret!1"


@pytest.fixture
def w() -> World:
    return World()


def as_role(role: str) -> APIClient:
    return client_for(create_and_login(role)["token"])


MATRIX = [
    ("/api/v1/admin/operations/dashboard", {"admin", "operations_admin"}),
    ("/api/v1/admin/operations/monitoring", {"admin", "operations_admin"}),
    ("/api/v1/admin/operations/restaurants", {"admin", "operations_admin"}),
    ("/api/v1/admin/operations/performance", {"admin", "operations_admin"}),
    ("/api/v1/admin/reports", {"admin", "finance_admin"}),
    ("/api/v1/admin/dashboard", {"admin", "operations_admin", "finance_admin", "support_admin"}),
]
ROLES = ["admin", "operations_admin", "finance_admin", "support_admin", "customer"]


def test_each_admin_view_is_open_to_its_roles_only(w: World) -> None:
    clients = {role: as_role(role) for role in ROLES}
    for path, allowed in MATRIX:
        for role, client in clients.items():
            expected = 200 if role in allowed else 403
            assert client.get(path).status_code == expected, f"{role} on {path}"


def test_shows_the_operations_dashboard_and_delivery_performance(w: World) -> None:
    order = delivered_order(w)
    ops = as_role("operations_admin")
    dash = ops.get("/api/v1/admin/operations/dashboard").json()["data"]
    assert dash["orders"]["total"] == 1
    assert dash["orders"]["completed"] == 1
    assert dash["orders"]["active"] == 0
    assert dash["restaurants"]["total"] == 1
    assert dash["riders"] == {"total": 1, "online": 1, "busy": 0}

    perf = ops.get("/api/v1/admin/operations/performance?days=7").json()["data"]
    assert perf["totals"]["delivered"] == 1
    assert perf["totals"]["within45Percent"] == 100  # all of it happened in this test
    assert perf["totals"]["avgPrepMinutes"] is not None
    assert len(perf["daily"]) == 7
    assert perf["daily"][-1]["delivered"] == 1
    top = perf["topRiders"][0]
    assert (top["deliveries"], top["name"], top["distanceMeters"]) == (
        1,
        "Ravi Rider",
        order.distance_m,
    )
    assert ops.get("/api/v1/admin/operations/performance?days=0").status_code == 422


def test_the_live_board_puts_late_orders_first(w: World) -> None:
    fresh = w.place_order()
    late = w.place_order()
    Order.objects.filter(pk=late).update(status_changed_at=timezone.now() - timedelta(minutes=11))
    board = as_role("operations_admin").get("/api/v1/admin/operations/monitoring").json()["data"]
    assert [i["id"] for i in board["items"]] == [late, fresh]
    assert board["items"][0]["late"] is True
    assert board["items"][0]["minutesInStatus"] >= 11
    assert board["items"][1]["late"] is False
    assert board["lateAfterMinutes"]["pending"] == 10

    places = as_role("operations_admin").get("/api/v1/admin/operations/restaurants").json()
    assert places["data"]["items"][0]["activeOrders"] == 2


def test_reports_gross_value_payment_mix_and_top_restaurants(w: World) -> None:
    order = delivered_order(w)
    w.place_order()  # placed, not delivered
    settlement = OrderSettlement.objects.get(order=order)
    report = as_role("finance_admin").get("/api/v1/admin/reports?days=7").json()["data"]
    totals = report["totals"]
    assert (totals["orders"], totals["delivered"]) == (2, 1)
    assert totals["gmvPaise"] == order.total_paise
    assert totals["averageOrderPaise"] == order.total_paise
    assert totals["platformRevenuePaise"] == settlement.platform_paise
    assert report["paymentMix"] == [{"method": "cod", "orders": 1, "paise": order.total_paise}]
    assert report["topRestaurants"][0]["name"] == "Spice Route Kitchen"
    assert report["statusCounts"] == {"delivered": 1, "pending": 1}
    assert len(report["daily"]) == 7


def test_the_platform_summary_shows_money_to_finance_roles_only(w: World) -> None:
    order = delivered_order(w)
    w.place_order()
    settlement = OrderSettlement.objects.get(order=order)

    ops = as_role("operations_admin").get("/api/v1/admin/dashboard").json()["data"]
    assert ops["orders"] == {"total": 2, "active": 1, "completed": 1, "cancelled": 0}
    assert ops["restaurants"] == 1
    assert ops["deliveryPartners"] == 1
    assert ops["customers"] >= 1
    assert "money" not in ops

    money = as_role("finance_admin").get("/api/v1/admin/dashboard").json()["data"]["money"]
    assert money["gmvPaise"] == order.total_paise
    assert money["platformRevenuePaise"] == settlement.platform_paise
    assert money["pendingRestaurantPaise"] == settlement.restaurant_paise
    assert money["pendingRiderPaise"] == settlement.rider_paise
    assert money["pendingSettlementsPaise"] == settlement.restaurant_paise + settlement.rider_paise


def test_login_history_lists_sign_ins_not_refreshes(w: World) -> None:
    admin = as_role("admin")
    first = login("support@bitebox.test", PASSWORD)
    refresh_with(cookie_of(first))  # a refresh rotates the token inside the same sign-in
    APIClient().post(
        "/api/v1/auth/login",
        {"email": "support@bitebox.test", "password": PASSWORD},
        format="json",
        HTTP_USER_AGENT="Test browser",
    )
    support_id = first.json()["data"]["user"]["id"]

    history = admin.get(f"/api/v1/admin/admins/{support_id}/logins").json()["data"]
    items = history["items"]
    # The seed's own sign-in (create_and_login) plus the two above.
    assert len(items) == history["pagination"]["total"]
    assert items[0]["userAgent"] == "Test browser"  # newest first
    assert all(i["active"] for i in items)
    assert items[0]["signedInAt"] >= items[1]["signedInAt"]

    # Staff history is under admins:manage; members are under users:manage.
    customer_id = w.customer["user"]["id"]
    assert admin.get(f"/api/v1/admin/users/{customer_id}/logins").status_code == 200
    assert admin.get(f"/api/v1/admin/users/{support_id}/logins").status_code == 404
    assert (
        as_role("operations_admin").get(f"/api/v1/admin/admins/{support_id}/logins").status_code
        == 403
    )


def test_login_history_marks_ended_sign_ins(w: World) -> None:
    from apps.accounts.models import Session

    customer_id = w.customer["user"]["id"]
    Session.objects.filter(user_id=customer_id).update(
        revoked_at=timezone.now(), revoked_reason="logout"
    )
    items = (
        as_role("admin").get(f"/api/v1/admin/users/{customer_id}/logins").json()["data"]["items"]
    )
    assert items
    assert items[0]["active"] is False
    assert items[0]["endedReason"] == "logout"
