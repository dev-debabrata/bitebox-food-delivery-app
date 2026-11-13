"""
Phase 13 (maps and tracking): tracking points (sampled, only while carrying an order, purged
after the retention period), GET /tracking/orders/{id}, and the arrival distance check.
"""

from datetime import timedelta
from typing import Any

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.tests.test_auth import create_and_login
from apps.orders.models import Order
from apps.orders.tests.test_orders import FARTHER, NEAR, World, client_for
from apps.realtime.tracking import persist_location
from apps.tracking.models import TrackingPoint
from apps.tracking.services import order_tracking, purge, record

pytestmark = pytest.mark.django_db


@pytest.fixture
def w() -> World:
    return World()


def assigned(w: World) -> str:
    w.go_online(w.r, NEAR)
    order_id = w.ready_order()
    assert w.accept(w.r, order_id).status_code == 200
    return order_id


def move(client: APIClient, where: dict[str, float]) -> Any:
    return client.put("/api/v1/delivery/me/location", where, format="json")


def track(client: APIClient, order_id: str) -> Any:
    return client.get(f"/api/v1/tracking/orders/{order_id}")


def test_points_are_kept_only_while_carrying_an_order_and_sampled(w: World) -> None:
    w.go_online(w.r, NEAR)
    assert move(w.r, NEAR).status_code == 200
    assert not TrackingPoint.objects.exists()  # just online: no trail kept

    order_id = assigned(w)
    assert move(w.r, NEAR).status_code == 200
    assert move(w.r, FARTHER).status_code == 200  # within the sample interval: not stored
    assert TrackingPoint.objects.filter(order_id=order_id).count() == 1
    later = timezone.now() + timedelta(seconds=20)
    rider = w.rider["user"]["id"]
    assert record(rider, order_id, FARTHER["latitude"], FARTHER["longitude"], 8.0, later)
    assert TrackingPoint.objects.filter(order_id=order_id).count() == 2

    # Socket fixes go through the same sampling.
    from apps.accounts.models import User

    user = User.objects.get(pk=rider)
    persist_location(user, 12.98, 77.64, 5.0, later + timedelta(seconds=5), order_id)
    assert TrackingPoint.objects.count() == 2
    persist_location(user, 12.98, 77.64, 5.0, later + timedelta(seconds=30), order_id)
    assert TrackingPoint.objects.count() == 3


def test_the_tracking_view_restores_the_map(w: World) -> None:
    order_id = assigned(w)
    move(w.r, NEAR)
    res = track(w.c, order_id)
    assert res.status_code == 200, res.json()
    data = res.json()["data"]
    assert data["tracking"] is True
    assert data["status"] == "assigned"
    assert data["lastPoint"]["latitude"] == pytest.approx(NEAR["latitude"])
    assert data["stale"] is False
    assert data["ageSeconds"] <= 5
    assert data["recentPath"] == [
        [pytest.approx(NEAR["latitude"]), pytest.approx(NEAR["longitude"])]
    ]

    # Old position: shown as stale.
    from apps.accounts.models import User

    customer = User.objects.get(pk=w.customer["user"]["id"])
    later = order_tracking(
        customer, Order.objects.get(pk=order_id).pk, timezone.now() + timedelta(minutes=3)
    )
    assert later["stale"] is True

    # Who may look: the customer, the rider, staff with orders:view; nobody else.
    assert track(w.r, order_id).status_code == 200
    assert (
        track(client_for(create_and_login("operations_admin")["token"]), order_id).status_code
        == 200
    )
    assert track(w.new_customer(), order_id).status_code == 404
    assert track(w.o, order_id).status_code == 404
    assert APIClient().get(f"/api/v1/tracking/orders/{order_id}").status_code == 401


def test_nothing_to_track_before_assignment_or_after_delivery(w: World) -> None:
    pending = w.place_order()
    data = track(w.c, pending).json()["data"]
    assert (data["tracking"], data["lastPoint"], data["recentPath"]) == (False, None, [])

    order_id = assigned(w)
    move(w.r, NEAR)
    for status in ("picked_up", "on_the_way", "delivered"):
        assert w.rider_set(w.r, order_id, status).status_code == 200
    done = track(w.c, order_id).json()["data"]
    assert (done["tracking"], done["recentPath"]) == (False, [])  # the path is not shown afterwards
    assert TrackingPoint.objects.filter(order_id=order_id).exists()  # but kept until purged


def test_old_points_are_purged(w: World) -> None:
    order_id = assigned(w)
    rider = w.rider["user"]["id"]
    old = timezone.now() - timedelta(days=31)
    record(rider, order_id, 12.97, 77.64, None, old)
    record(rider, order_id, 12.97, 77.64, None, timezone.now())
    assert purge() == 1
    assert TrackingPoint.objects.count() == 1


def test_arrival_far_from_the_restaurant_is_flagged_for_admins(w: World) -> None:
    order_id = assigned(w)  # the rider is ~110 m away
    w.rider_set(w.r, order_id, "arrived_at_restaurant")
    admin = client_for(create_and_login("admin")["token"])
    near = admin.get(f"/api/v1/admin/orders/{order_id}").json()["data"]["order"]
    assert 50 < near["arrivalDistanceMeters"] < 200
    assert near["arrivedFar"] is False
    assert (
        "arrivalDistanceMeters" not in w.c.get(f"/api/v1/orders/{order_id}").json()["data"]["order"]
    )

    far_rider = w.new_rider(FARTHER)  # online ~2 km from the restaurant
    other = w.ready_order()  # the first rider is busy: offered to the far one
    assert w.accept(far_rider, other).status_code == 200
    w.rider_set(far_rider, other, "arrived_at_restaurant")
    far = admin.get(f"/api/v1/admin/orders/{other}").json()["data"]["order"]
    assert far["arrivalDistanceMeters"] > 1500
    assert far["arrivedFar"] is True
