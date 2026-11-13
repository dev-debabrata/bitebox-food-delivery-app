"""
Port of the restaurant-panel parts of the Node API's tests/reviews.test.js ("lets the restaurant
read, filter and reply", "groups reviews by order") and the earnings part of tests/payments.test.js.

Reviews are stored directly with the same fields the review service writes, then the cached
ratings are rebuilt (the customer API itself is tested in test_reviews.py).
"""

from datetime import timedelta
from typing import Any

import pytest
from django.utils import timezone

from apps.finance.models import OrderSettlement
from apps.notifications.models import Notification
from apps.orders.models import Order
from apps.orders.tests.test_orders import NEAR, World
from apps.reviews.models import Review, ReviewReport, ReviewTarget
from apps.reviews.services import refresh_rating, summarize

pytestmark = pytest.mark.django_db


@pytest.fixture
def w() -> World:
    return World()


def delivered_order(w: World, dishes: tuple[str, ...] = ("Butter Chicken",)) -> Order:
    w.go_online(w.r, NEAR)
    for dish in dishes:
        w.add(dish=dish, qty=2)
    res = w.place()
    assert res.status_code == 201, res.json()
    order_id = res.json()["data"]["order"]["id"]
    for status in ("confirmed", "preparing", "ready_for_pickup"):
        w.restaurant_set(order_id, status)
    assert w.accept(w.r, order_id).status_code == 200
    for status in ("picked_up", "on_the_way", "delivered"):
        assert w.rider_set(w.r, order_id, status).status_code == 200
    return Order.objects.get(pk=order_id)


def review(
    order: Order, target: str, rating: int, comment: str = "", dish: str | None = None
) -> Review:
    food = order.items.get(name=dish) if dish else None
    row = Review.objects.create(
        target=target,
        customer=order.customer,
        customer_name=order.customer.name,
        order=order,
        order_number=order.order_number,
        restaurant=order.restaurant,
        food_item_id=food.food_item_id if food else None,
        food_name=dish or "",
        delivery_partner=order.delivery_partner if target == ReviewTarget.RIDER else None,
        rating=rating,
        comment=comment,
    )
    subject: Any = {
        ReviewTarget.RESTAURANT: order.restaurant_id,
        ReviewTarget.FOOD: food.food_item_id if food else None,
        ReviewTarget.RIDER: order.delivery_partner_id,
    }[ReviewTarget(target)]
    refresh_rating(target, subject)
    return row


def test_summaries_round_like_node() -> None:
    assert summarize({}) == {"average": 0, "count": 0, "distribution": [0, 0, 0, 0, 0]}
    assert summarize({5: 2, 4: 1}) == {"average": 4.67, "count": 3, "distribution": [0, 0, 0, 1, 2]}


def test_lets_the_restaurant_read_filter_and_reply_without_touching_the_review(w: World) -> None:
    order = delivered_order(w, ("Butter Chicken", "Garlic Naan"))
    r = review(order, "restaurant", 2, "Too salty")
    review(order, "food", 5, dish="Garlic Naan")
    rider_review = review(order, "rider", 1)

    listed = w.o.get("/api/v1/my/restaurant/reviews/orders")
    assert listed.status_code == 200
    items = listed.json()["data"]["items"]
    assert len(items) == 1
    seen = items[0]["reviews"]
    assert len(seen) == 2  # never the rider's
    item = next(x for x in seen if x["target"] == "restaurant")
    assert "customer" not in item  # no customer id
    assert item["authorName"] == order.customer.name
    assert item["orderNumber"] == order.order_number
    assert item["reportedByYou"] is False

    filtered = w.o.get(
        "/api/v1/my/restaurant/reviews/orders?target=food&rating=5&sort=lowest&limit=1"
    ).json()["data"]
    assert filtered["pagination"]["total"] == 1
    none = w.o.get("/api/v1/my/restaurant/reviews/orders?target=food&rating=1").json()["data"]
    assert none["items"] == []
    assert w.o.get("/api/v1/my/restaurant/reviews/orders?sort=best").status_code == 422

    summary = w.o.get("/api/v1/my/restaurant/reviews/summary").json()["data"]
    assert summary["rating"]["average"] == 2
    assert summary["unanswered"] == 2
    naan = next(f for f in summary["foods"] if f["name"] == "Garlic Naan")
    assert naan["rating"]["count"] == 1

    reply = w.o.put(
        f"/api/v1/my/restaurant/reviews/{r.pk}/response",
        {"text": "Sorry about that, we have adjusted the recipe."},
        format="json",
    )
    assert reply.status_code == 200
    assert reply.json()["message"] == "Reply posted"
    body = reply.json()["data"]["review"]
    assert (body["comment"], body["rating"]) == ("Too salty", 2)  # review untouched
    assert body["response"]["text"].startswith("Sorry about that")
    assert body["response"]["respondedAt"]
    # The customer hears about the first reply only.
    w.o.put(
        f"/api/v1/my/restaurant/reviews/{r.pk}/response", {"text": "Edited reply"}, format="json"
    )
    assert Notification.objects.filter(type="review.response").count() == 1

    one = w.o.get(f"/api/v1/my/restaurant/reviews/orders/{order.pk}").json()["data"]
    assert one["unanswered"] == 1

    for who in (w.c, w.r):  # customers and riders cannot reply as the restaurant
        res = who.put(
            f"/api/v1/my/restaurant/reviews/{r.pk}/response", {"text": "Fake reply"}, format="json"
        )
        assert res.status_code == 403
    not_ours = w.o.put(
        f"/api/v1/my/restaurant/reviews/{rider_review.pk}/response",
        {"text": "Not ours"},
        format="json",
    )
    assert not_ours.status_code == 404
    short = w.o.put(
        f"/api/v1/my/restaurant/reviews/{r.pk}/response", {"text": " x "}, format="json"
    )
    assert short.status_code == 422
    assert (
        short.json()["error"]["details"][0]["message"] == "The reply must be 2 to 1000 characters"
    )

    removed = w.o.delete(f"/api/v1/my/restaurant/reviews/{r.pk}/response")
    assert removed.json()["message"] == "Reply removed"
    assert removed.json()["data"]["review"]["response"] is None


def test_groups_reviews_by_order_for_the_restaurant(w: World) -> None:
    first = delivered_order(w, ("Butter Chicken", "Garlic Naan"))
    review(first, "restaurant", 4, "Good overall")
    review(first, "food", 5, dish="Garlic Naan")
    review(first, "food", 5, dish="Butter Chicken")
    review(first, "rider", 3)
    second = delivered_order(w)
    flagged = review(second, "restaurant", 1, "Bad")
    ReviewReport.objects.create(
        review=flagged, reporter_id=w.owner["user"]["id"], reporter_role="restaurant", reason="spam"
    )

    rows = w.o.get("/api/v1/my/restaurant/reviews/orders").json()["data"]
    assert len(rows["items"]) == 2  # one row per order
    assert rows["pagination"]["total"] == 2
    assert rows["items"][0]["order"] == str(second.pk)  # newest first
    row = next(r for r in rows["items"] if r["order"] == str(first.pk))
    assert [(r["target"], r["foodName"]) for r in row["reviews"]] == [
        ("restaurant", None),
        ("food", "Butter Chicken"),
        ("food", "Garlic Naan"),
    ]  # restaurant first, then dishes; never the rider
    assert row["unanswered"] == 3
    assert row["authorName"] == first.customer.name
    flagged_row = next(r for r in rows["items"] if r["order"] == str(second.pk))
    assert flagged_row["reviews"][0]["reportedByYou"] is True

    # Filters pick orders; the row still shows the whole order.
    five = w.o.get("/api/v1/my/restaurant/reviews/orders?rating=5").json()["data"]["items"]
    assert len(five) == 1
    assert len(five[0]["reviews"]) == 3
    lowest = w.o.get("/api/v1/my/restaurant/reviews/orders?sort=lowest").json()["data"]["items"]
    assert lowest[0]["order"] == str(second.pk)

    one = w.o.get(f"/api/v1/my/restaurant/reviews/orders/{first.pk}").json()["data"]
    assert len(one["reviews"]) == 3
    assert one["orderNumber"] == row["orderNumber"]
    for who in (w.c, w.r):
        assert who.get(f"/api/v1/my/restaurant/reviews/orders/{first.pk}").status_code == 403
    missing = w.o.get(f"/api/v1/my/restaurant/reviews/orders/{w.customer['user']['id']}")
    assert missing.status_code == 404
    assert missing.json()["message"] == "No reviews for this order"


def test_restaurant_earnings_come_from_the_settlements(w: World) -> None:
    order = delivered_order(w)
    settlement = OrderSettlement.objects.get(order=order)
    res = w.o.get("/api/v1/my/restaurant/earnings?days=7")
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["days"] == 7
    assert data["totals"]["orders"] == 1
    assert data["totals"]["earningsPaise"] == settlement.restaurant_paise
    assert data["totals"]["distanceMeters"] == order.distance_m
    assert len(data["daily"]) == 7  # one entry per day, quiet days included
    assert data["daily"][-1]["orders"] == 1
    assert sum(d["orders"] for d in data["daily"]) == 1
    recent = data["recent"][0]
    assert (recent["id"], recent["earningsPaise"], recent["totalPaise"]) == (
        str(order.pk),
        settlement.restaurant_paise,
        order.total_paise,
    )
    assert recent["restaurantName"] == "Spice Route Kitchen"

    # Older than the window: not counted.
    OrderSettlement.objects.filter(pk=settlement.pk).update(
        settled_at=timezone.now() - timedelta(days=8)
    )
    assert w.o.get("/api/v1/my/restaurant/earnings?days=7").json()["data"]["totals"]["orders"] == 0
    default = w.o.get("/api/v1/my/restaurant/earnings").json()["data"]
    assert default["days"] == 30
    assert default["totals"]["orders"] == 1
    assert w.o.get("/api/v1/my/restaurant/earnings?days=0").status_code == 422
    assert w.c.get("/api/v1/my/restaurant/earnings").status_code == 403
