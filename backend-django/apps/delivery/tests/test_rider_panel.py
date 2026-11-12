"""
The rider panel's Django endpoints: reviews (port of "shows riders their ratings without the
customer's details" in the Node API's tests/reviews.test.js), earnings (tests/payments.test.js),
and the Phase 9 additions: dashboard figures and what a delivery request pays.
"""

from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.tests.test_auth import register, token_of
from apps.finance.models import OrderSettlement
from apps.orders.tests.test_orders import NEAR, World, client_for
from apps.reviews.tests.test_restaurant_reviews import delivered_order, review

pytestmark = pytest.mark.django_db


@pytest.fixture
def w() -> World:
    return World()


def test_shows_riders_their_ratings_without_the_customers_details(w: World) -> None:
    order = delivered_order(w)
    review(order, "rider", 4, "Polite and on time")
    review(order, "restaurant", 1, "Cold food")

    res = w.r.get("/api/v1/delivery/reviews")
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["summary"]["average"] == 4
    assert len(data["items"]) == 1  # only reviews of the rider
    item = data["items"][0]
    assert item["authorName"] == order.customer.name
    assert sorted(item) == [
        "authorName",
        "comment",
        "createdAt",
        "editedAt",
        "id",
        "orderNumber",
        "rating",
        "reportedByYou",
    ]
    assert w.r.get("/api/v1/delivery/reviews?rating=5").json()["data"]["items"] == []
    assert w.r.get("/api/v1/delivery/reviews?rating=9").status_code == 422

    res, _ = register(APIClient(), role="delivery", name="Dev Rider")
    other = client_for(token_of(res))
    theirs = other.get("/api/v1/delivery/reviews").json()["data"]
    assert theirs["items"] == []
    assert theirs["summary"]["count"] == 0
    assert w.c.get("/api/v1/delivery/reviews").status_code == 403


def test_rider_earnings_come_from_the_settlements(w: World) -> None:
    order = delivered_order(w)
    settlement = OrderSettlement.objects.get(order=order)
    data = w.r.get("/api/v1/delivery/earnings?days=7").json()["data"]
    assert data["totals"]["orders"] == 1
    assert data["totals"]["earningsPaise"] == settlement.rider_paise
    assert len(data["daily"]) == 7
    assert data["recent"][0]["earningsPaise"] == settlement.rider_paise
    assert w.o.get("/api/v1/delivery/earnings").status_code == 403


def test_rider_stats_for_today_the_week_and_all_time(w: World) -> None:
    empty = w.r.get("/api/v1/delivery/stats").json()["data"]
    assert empty["today"] == {"deliveries": 0, "earningsPaise": 0}

    first = delivered_order(w)
    second = delivered_order(w)
    pay = [OrderSettlement.objects.get(order=o).rider_paise for o in (first, second)]
    # One delivery from three weeks ago counts only in the all-time total.
    OrderSettlement.objects.filter(order=second).update(
        settled_at=timezone.now() - timedelta(days=21)
    )
    review(first, "rider", 5)

    stats = w.r.get("/api/v1/delivery/stats").json()["data"]
    assert stats["today"] == {"deliveries": 1, "earningsPaise": pay[0]}
    assert stats["week"] == {"deliveries": 1, "earningsPaise": pay[0]}
    assert stats["total"] == {"deliveries": 2, "earningsPaise": sum(pay)}
    assert stats["rating"] == {"average": 5.0, "count": 1}
    assert w.c.get("/api/v1/delivery/stats").status_code == 403


def test_a_request_shows_what_it_pays_and_how_far_the_pickup_is(w: World) -> None:
    w.go_online(w.r, NEAR)
    order_id = w.ready_order()
    offer = w.dashboard(w.r).json()["data"]["offer"]
    assert offer["id"] == order_id
    # ₹20 + ₹6 per started km of the restaurant → customer distance (config/earnings).
    km = -(-offer["distanceMeters"] // 1000)
    assert offer["estimatedEarningsPaise"] == 2000 + km * 600
    # The rider went online ~110 m from the restaurant.
    assert 50 <= offer["pickupDistanceMeters"] <= 200

    w.accept(w.r, order_id)
    active = w.dashboard(w.r).json()["data"]["activeOrder"]
    assert active["estimatedEarningsPaise"] == offer["estimatedEarningsPaise"]
    assert "pickupDistanceMeters" not in active
