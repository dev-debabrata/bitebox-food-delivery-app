"""
Phase 11 (order lifecycle and dispatch), from the master prompt §6 and decision D3: the rider's
arrival at the restaurant, the delivery OTP, the restaurant's preparation time, manual
assignment by an admin, and the order timeline.
"""

import uuid
from datetime import timedelta
from typing import Any

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.tests.test_auth import create_and_login
from apps.audit.models import AuditLog
from apps.delivery.models import DeliveryPartner
from apps.dispatch.models import AssignmentStatus, DeliveryAssignment
from apps.notifications.models import Notification
from apps.orders.models import Order
from apps.orders.tests.test_orders import FARTHER, NEAR, World, client_for
from apps.orders.workflow import can_transition

pytestmark = pytest.mark.django_db


@pytest.fixture
def w() -> World:
    return World()


def assigned(w: World) -> str:
    w.go_online(w.r, NEAR)
    order_id = w.ready_order()
    assert w.accept(w.r, order_id).status_code == 200
    return order_id


def admin() -> APIClient:
    return client_for(create_and_login("admin")["token"])


# --- arrival at the restaurant -----------------------------------------------------------------


def test_the_rider_marks_arrival_then_pickup(w: World) -> None:
    order_id = assigned(w)
    active = w.dashboard(w.r).json()["data"]["activeOrder"]
    assert active["nextStatuses"] == ["arrived_at_restaurant", "picked_up"]
    assert active["deliveryOtpRequired"] is False

    arrived = w.rider_set(w.r, order_id, "arrived_at_restaurant")
    assert arrived.status_code == 200
    assert arrived.json()["message"].startswith("Marked as arrived")
    assert arrived.json()["data"]["activeOrder"]["nextStatuses"] == ["picked_up"]
    # The restaurant is told, and still sees its pickup deadline.
    assert Notification.objects.filter(
        user_id=w.owner["user"]["id"], title__startswith="Rider has arrived"
    ).exists()
    board = w.o.get(f"/api/v1/my/restaurant/orders/{order_id}").json()["data"]["order"]
    assert board["status"] == "arrived_at_restaurant"
    assert board["pickupBy"]

    assert w.rider_set(w.r, order_id, "picked_up").status_code == 200
    # Arrival is optional: riders on older apps go straight to "picked up".
    assert can_transition("assigned", "picked_up", "delivery")
    assert not can_transition("arrived_at_restaurant", "on_the_way", "delivery")


def test_an_order_waiting_at_the_counter_still_times_out(w: World) -> None:
    from apps.dispatch.services import sweep

    order_id = assigned(w)
    w.rider_set(w.r, order_id, "arrived_at_restaurant")
    summary = sweep(timezone.now() + timedelta(minutes=31))
    assert summary["pickup_expired"] == 1
    assert Order.objects.get(pk=order_id).status == "cancelled"


# --- delivery OTP ------------------------------------------------------------------------------


def test_delivery_needs_the_customers_code(w: World) -> None:
    order_id = assigned(w)
    w.rider_set(w.r, order_id, "picked_up")
    code = Order.objects.get(pk=order_id).delivery_otp
    assert len(code) == 4
    assert code.isdigit()

    # Only the customer sees it; the rider sees that it is needed; the admin sees it is pending.
    mine = w.c.get(f"/api/v1/orders/{order_id}").json()["data"]["order"]
    assert mine["deliveryOtp"] == code
    rider_view = w.dashboard(w.r).json()["data"]["activeOrder"]
    assert rider_view["deliveryOtpRequired"] is True
    assert "deliveryOtp" not in rider_view
    admin_view = admin().get(f"/api/v1/admin/orders/{order_id}").json()["data"]["order"]
    assert "deliveryOtp" not in admin_view
    assert admin_view["deliveryOtpPending"] is True
    # The pickup notification carries the code to the customer.
    assert Notification.objects.filter(
        user_id=w.customer["user"]["id"], body__contains=code
    ).exists()

    w.rider_set(w.r, order_id, "on_the_way")
    missing = w.rider_set(w.r, order_id, "delivered", otp="")
    assert missing.status_code == 422
    assert missing.json()["error"]["details"][0] == {
        "field": "otp",
        "message": "Ask the customer for their delivery code",
    }
    wrong = "0000" if code != "0000" else "1111"
    bad = w.rider_set(w.r, order_id, "delivered", otp=wrong)
    assert bad.status_code == 422
    assert "3 tries left" in bad.json()["error"]["details"][0]["message"]
    assert Order.objects.get(pk=order_id).status == "on_the_way"
    assert w.rider_set(w.r, order_id, "delivered", otp="12x4").status_code == 422  # not digits

    done = w.rider_set(w.r, order_id, "delivered", otp=code)
    assert done.status_code == 200
    assert Order.objects.get(pk=order_id).status == "delivered"
    # The code is no longer shown once delivered; a repeat is harmless.
    assert w.c.get(f"/api/v1/orders/{order_id}").json()["data"]["order"]["deliveryOtp"] is None
    assert w.rider_set(w.r, order_id, "delivered", otp="").status_code == 200


def test_too_many_wrong_codes_lock_until_support_resets_it(w: World) -> None:
    order_id = assigned(w)
    for status in ("picked_up", "on_the_way"):
        w.rider_set(w.r, order_id, status)
    code = Order.objects.get(pk=order_id).delivery_otp
    wrong = "0000" if code != "0000" else "1111"
    for _ in range(5):
        assert w.rider_set(w.r, order_id, "delivered", otp=wrong).status_code == 422
    locked = w.rider_set(w.r, order_id, "delivered", otp=code)  # even the right code now
    assert locked.status_code == 409
    assert locked.json()["error"]["code"] == "OTP_LOCKED"

    support = admin()
    reset = support.post(f"/api/v1/admin/orders/{order_id}/delivery-code")
    assert reset.status_code == 200
    assert reset.json()["message"] == "New delivery code sent to the customer"
    order = Order.objects.get(pk=order_id)
    assert order.delivery_otp_attempts == 0
    assert Notification.objects.filter(
        type="order.delivery_code", body__contains=order.delivery_otp
    ).exists()
    assert AuditLog.objects.filter(action="order.delivery_code").exists()
    assert w.rider_set(w.r, order_id, "delivered", otp=order.delivery_otp).status_code == 200
    # Nothing to reset any more.
    assert support.post(f"/api/v1/admin/orders/{order_id}/delivery-code").status_code == 409


def test_the_code_can_be_switched_off(w: World, settings: Any) -> None:
    settings.DELIVERY_OTP_REQUIRED = False
    order_id = assigned(w)
    for status in ("picked_up", "on_the_way"):
        w.rider_set(w.r, order_id, status)
    assert Order.objects.get(pk=order_id).delivery_otp == ""
    assert w.rider_set(w.r, order_id, "delivered", otp="").status_code == 200


# --- preparation time --------------------------------------------------------------------------


def test_the_restaurant_sets_a_preparation_time_when_accepting(w: World) -> None:
    order_id = w.place_order()
    before = timezone.now()
    res = w.o.patch(
        f"/api/v1/my/restaurant/orders/{order_id}/status",
        {"status": "confirmed", "prepMinutes": 25},
        format="json",
    )
    assert res.status_code == 200
    order = res.json()["data"]["order"]
    assert order["prepMinutes"] == 25
    stored = Order.objects.get(pk=order_id)
    assert timedelta(minutes=24) < stored.ready_by - before < timedelta(minutes=26)
    # The customer sees when the food should be ready.
    assert w.c.get(f"/api/v1/orders/{order_id}").json()["data"]["order"]["readyBy"]

    other = w.place_order()
    w.restaurant_set(other, "confirmed")  # no time given: the restaurant's usual one
    assert (
        Order.objects.get(pk=other).prep_minutes
        == Order.objects.get(pk=other).restaurant.avg_prep_time_minutes
    )
    too_long = w.o.patch(
        f"/api/v1/my/restaurant/orders/{w.place_order()}/status",
        {"status": "confirmed", "prepMinutes": 500},
        format="json",
    )
    assert too_long.status_code == 422
    assert too_long.json()["error"]["details"][0]["message"] == (
        "Preparation time must be 5 to 120 minutes"
    )


# --- manual assignment -------------------------------------------------------------------------


def test_an_admin_assigns_a_chosen_rider(w: World) -> None:
    other = w.new_rider(FARTHER)  # online and free
    w.go_online(w.r, NEAR)
    order_id = w.ready_order()  # offered to the nearer rider
    assert DeliveryAssignment.objects.get(order_id=order_id).status == AssignmentStatus.OFFERED
    other_id = other.get("/api/v1/auth/me").json()["data"]["user"]["id"]

    support = admin()
    detail = support.get(f"/api/v1/admin/orders/{order_id}").json()["data"]["order"]
    assert detail["canAssign"] is True
    res = support.post(
        f"/api/v1/admin/orders/{order_id}/assign", {"riderId": other_id}, format="json"
    )
    assert res.status_code == 200, res.json()
    assert res.json()["message"] == "Rider assigned"
    order = res.json()["data"]["order"]
    assert (order["status"], order["deliveryPartner"], order["canAssign"]) == (
        "assigned",
        other_id,
        False,
    )
    # The open offer was withdrawn and its rider freed; the new rider carries the order.
    statuses = dict(
        DeliveryAssignment.objects.filter(order_id=order_id).values_list("rider_id", "status")
    )
    assert statuses[uuid.UUID(w.rider["user"]["id"])] == AssignmentStatus.CANCELLED
    assert statuses[uuid.UUID(other_id)] == AssignmentStatus.ACCEPTED
    assert DeliveryPartner.objects.get(user_id=w.rider["user"]["id"]).current_offer_id is None
    assert str(DeliveryPartner.objects.get(user_id=other_id).active_order_id) == order_id
    assert AuditLog.objects.filter(action="order.assign").exists()
    # The assigned rider can carry on as usual.
    assert w.dashboard(other).json()["data"]["activeOrder"]["id"] == order_id
    assert w.rider_set(other, order_id, "picked_up").status_code == 200


def test_manual_assignment_needs_a_waiting_order_and_a_free_rider(w: World) -> None:
    support = admin()
    rider_id = w.rider["user"]["id"]
    pending = w.place_order()
    early = support.post(
        f"/api/v1/admin/orders/{pending}/assign", {"riderId": rider_id}, format="json"
    )
    assert early.status_code == 409

    order_id = w.ready_order()  # nobody online: no offer
    offline = support.post(
        f"/api/v1/admin/orders/{order_id}/assign", {"riderId": rider_id}, format="json"
    )
    assert offline.status_code == 409
    assert offline.json()["error"]["code"] == "RIDER_UNAVAILABLE"
    customer = support.post(
        f"/api/v1/admin/orders/{order_id}/assign",
        {"riderId": w.customer["user"]["id"]},
        format="json",
    )
    assert customer.status_code == 404
    assert (
        support.post(f"/api/v1/admin/orders/{order_id}/assign", {}, format="json").status_code
        == 422
    )
    ops_support = client_for(create_and_login("support_admin")["token"])
    assert (
        ops_support.post(
            f"/api/v1/admin/orders/{order_id}/assign", {"riderId": rider_id}, format="json"
        ).status_code
        == 403
    )  # orders:manage only


# --- timeline ----------------------------------------------------------------------------------


def test_the_order_timeline(w: World) -> None:
    order_id = assigned(w)
    w.rider_set(w.r, order_id, "arrived_at_restaurant")
    res = w.c.get(f"/api/v1/orders/{order_id}/timeline")
    assert res.status_code == 200
    data = res.json()["data"]
    assert [e["label"] for e in data["events"]] == [
        "Order placed",
        "Accepted by the restaurant",
        "Being prepared",
        "Ready for pickup",
        "Rider assigned",
        "Rider at the restaurant",
    ]
    assert data["events"][1]["by"] == "restaurant"
    assert data["readyBy"]
    assert w.new_customer().get(f"/api/v1/orders/{order_id}/timeline").status_code == 404
    assert admin().get(f"/api/v1/admin/orders/{order_id}/timeline").status_code == 200
