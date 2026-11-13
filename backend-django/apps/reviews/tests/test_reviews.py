"""
Port of the Node API's tests/reviews.test.js: customers writing, editing and deleting reviews,
"rate your experience" with photos, the public lists, reports, admin moderation, grouping by order
and the analytics. The restaurant-panel parts are also in test_restaurant_reviews.py.

Orders are driven through the real workflow to "delivered". Racing double submits cannot run in
parallel inside one test transaction, so the duplicates are sent one after the other; the unique
constraints are what stop both.
"""

import base64
import io
from datetime import timedelta
from typing import Any

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.tests.test_auth import create_and_login, register, token_of
from apps.audit.models import AuditLog
from apps.delivery.models import DeliveryPartner
from apps.menus.models import FoodItem
from apps.notifications.models import Notification
from apps.orders.models import Order, OrderStatusHistory
from apps.orders.tests.test_orders import NEAR, World, client_for
from apps.restaurants.models import Restaurant
from apps.reviews.models import Review, ReviewEdit, ReviewReport
from apps.reviews.services import refresh_rating

pytestmark = pytest.mark.django_db

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)


class Reviews(World):
    """The order World plus an admin and review helpers."""

    def __init__(self) -> None:
        super().__init__()
        self.admin = create_and_login("admin")
        self.a = client_for(self.admin["token"])

    def delivered_order(self, dishes: tuple[str, ...] = ("Butter Chicken",)) -> str:
        """A real order driven through the real workflow to "delivered"."""
        assert self.go_online(self.r, NEAR).status_code == 200
        for dish in dishes:
            self.add(dish=dish, qty=1)
        res = self.place()
        assert res.status_code == 201, res.json()
        order_id = str(res.json()["data"]["order"]["id"])
        for status in ("confirmed", "preparing", "ready_for_pickup"):
            assert self.restaurant_set(order_id, status).status_code == 200
        assert self.accept(self.r, order_id).status_code == 200
        for status in ("picked_up", "on_the_way", "delivered"):
            assert self.rider_set(self.r, order_id, status).status_code == 200
        assert Order.objects.get(pk=order_id).status == "delivered"
        return order_id

    def review(self, client: APIClient, **body: Any) -> Any:
        return client.post("/api/v1/reviews", body, format="json")

    def rate_restaurant(
        self, client: APIClient, order_id: str, rating: Any, comment: str | None = None
    ) -> Any:
        body: dict[str, Any] = {"orderId": order_id, "target": "restaurant", "rating": rating}
        if comment is not None:
            body["comment"] = comment
        return self.review(client, **body)

    def food_id(self, name: str) -> str:
        return str(self.food[name].pk)

    def second_customer(self) -> APIClient:
        res, _ = register(APIClient(), name="Kiran Mehta")
        return client_for(token_of(res))

    def upload(self, client: APIClient) -> Any:
        image = io.BytesIO(PNG)
        image.name = "dish.png"
        return client.post("/api/v1/uploads/review-images", {"image": image}, format="multipart")

    def rate_order(self, client: APIClient, order_id: str, **body: Any) -> Any:
        return client.post(f"/api/v1/orders/{order_id}/reviews", body, format="json")


@pytest.fixture
def w() -> Reviews:
    return Reviews()


def restaurant() -> Restaurant:
    return Restaurant.objects.get(slug="spice-route-kitchen")


# --- who can review what ------------------------------------------------------------------------


def test_rejects_reviews_for_orders_that_are_not_delivered(w: Reviews) -> None:
    order_id = w.place_order()
    res = w.rate_restaurant(w.c, order_id, 5)
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "ORDER_NOT_DELIVERED"
    state = w.c.get(f"/api/v1/orders/{order_id}/reviews").json()["data"]
    assert state["canReview"] is False
    assert state["reason"] == "You can review an order once it has been delivered"
    assert Review.objects.count() == 0


def test_needs_a_signed_in_customer(w: Reviews) -> None:
    order_id = w.delivered_order()
    anonymous = APIClient().post(
        "/api/v1/reviews",
        {"orderId": order_id, "target": "restaurant", "rating": 5},
        format="json",
    )
    assert anonymous.status_code == 401
    for who in (w.o, w.r, w.a):
        assert w.rate_restaurant(who, order_id, 1).status_code == 403  # only customers write


def test_never_lets_a_customer_review_someone_elses_order(w: Reviews) -> None:
    order_id = w.delivered_order()
    other = w.second_customer()
    assert w.rate_restaurant(other, order_id, 1).status_code == 404  # the order id is not trusted
    assert other.get(f"/api/v1/orders/{order_id}/reviews").status_code == 404


def test_closes_the_review_window_after_the_policy_period(w: Reviews) -> None:
    order_id = w.delivered_order()
    OrderStatusHistory.objects.filter(order_id=order_id, to_status="delivered").update(
        created_at=timezone.now() - timedelta(days=31)
    )
    res = w.rate_restaurant(w.c, order_id, 4)
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "REVIEW_WINDOW_CLOSED"
    assert res.json()["message"] == "Reviews can be written up to 30 days after delivery"


def test_validates_the_rating_the_dish_and_the_comment(w: Reviews) -> None:
    order_id = w.delivered_order()
    for rating in (0, 6, 3.5, "five", None, True):
        res = w.rate_restaurant(w.c, order_id, rating)
        assert res.status_code == 422, rating
        detail = res.json()["error"]["details"][0]
        assert detail == {"field": "rating", "message": "Choose a rating from 1 to 5 stars"}
    too_long = w.rate_restaurant(w.c, order_id, 4, "x" * 1001)
    assert too_long.status_code == 422
    assert too_long.json()["error"]["details"][0]["message"] == (
        "Keep the review under 1000 characters"
    )
    not_text = w.review(w.c, orderId=order_id, target="restaurant", rating=4, comment=5)
    assert not_text.json()["error"]["details"][0]["message"] == "Comment must be text"

    no_dish = w.review(w.c, orderId=order_id, target="food", rating=4)
    assert no_dish.status_code == 422
    assert no_dish.json()["error"]["details"][0]["field"] == "foodItemId"
    not_ordered = w.review(
        w.c, orderId=order_id, target="food", foodItemId=w.food_id("Masala Dosa"), rating=4
    )
    assert not_ordered.status_code == 422  # only dishes that were in the order
    assert not_ordered.json()["error"]["details"] == [
        {"field": "foodItemId", "message": "Not in this order"}
    ]
    bad_target = w.review(w.c, orderId=order_id, target="admin", rating=4)
    assert bad_target.status_code == 422
    bad_order = w.review(w.c, orderId="nope", target="restaurant", rating=4)
    assert bad_order.json()["error"]["details"][0] == {
        "field": "orderId",
        "message": "Invalid order",
    }
    assert Review.objects.count() == 0


# --- the customer journey -----------------------------------------------------------------------


def test_reviews_the_restaurant_each_dish_and_the_rider_once_each(w: Reviews) -> None:
    order_id = w.delivered_order(("Butter Chicken", "Garlic Naan"))

    before = w.c.get(f"/api/v1/orders/{order_id}/reviews").json()["data"]
    assert before["canReview"] is True
    assert before["orderId"] == order_id
    assert before["closesAt"]
    assert before["restaurant"]["name"] == "Spice Route Kitchen"
    assert [i["name"] for i in before["items"]] == ["Butter Chicken", "Garlic Naan"]
    assert before["rider"] == {"review": None}  # a rider delivered this order

    r = w.rate_restaurant(w.c, order_id, 4, "  Lovely food, quick service ")
    assert r.status_code == 201, r.json()
    assert r.json()["message"] == "Thanks for your review"
    mine = r.json()["data"]["review"]
    assert mine["comment"] == "Lovely food, quick service"
    assert mine["authorName"] == "Asha Customer"
    assert mine["status"] == "published"
    assert mine["order"] == order_id
    assert mine["moderation"] is None
    assert mine["editableUntil"]
    assert mine["verifiedOrder"] is True
    f = w.review(
        w.c, orderId=order_id, target="food", foodItemId=w.food_id("Butter Chicken"), rating=5
    )
    assert f.status_code == 201
    assert f.json()["data"]["review"]["foodName"] == "Butter Chicken"
    d = w.review(w.c, orderId=order_id, target="rider", rating=3)
    assert d.status_code == 201
    assert d.json()["data"]["review"]["deliveryPartner"] == w.rider["user"]["id"]

    # Duplicates hit the unique constraints.
    for rating in (1, 2):
        res = w.rate_restaurant(w.c, order_id, rating)
        assert res.status_code == 409
        assert res.json()["error"]["code"] == "DUPLICATE_REVIEW"
    again = w.review(
        w.c, orderId=order_id, target="food", foodItemId=w.food_id("Butter Chicken"), rating=1
    )
    assert again.status_code == 409
    assert Review.objects.count() == 3

    # Summaries on each subject.
    rest = restaurant()
    assert (float(rest.rating_average), rest.rating_count, rest.rating_distribution) == (
        4,
        1,
        [0, 0, 0, 1, 0],
    )
    assert float(FoodItem.objects.get(name="Butter Chicken").rating_average) == 5
    assert FoodItem.objects.get(name="Garlic Naan").rating_count == 0
    assert float(DeliveryPartner.objects.get(user_id=w.rider["user"]["id"]).rating_average) == 3

    # The restaurant and the rider hear about it.
    owner_id = w.owner["user"]["id"]
    titles = list(
        Notification.objects.filter(type="review.new", user_id=owner_id).values_list(
            "title", flat=True
        )
    )
    assert sorted(titles) == ["New 4★ review", "New 5★ review"]
    rider_note = Notification.objects.get(type="review.new", user_id=w.rider["user"]["id"])
    assert (rider_note.title, rider_note.link) == ("New 3★ delivery rating", "/delivery/reviews")

    after = w.c.get(f"/api/v1/orders/{order_id}/reviews").json()["data"]
    assert after["restaurant"]["review"]["rating"] == 4
    assert after["items"][0]["review"]["rating"] == 5
    assert after["items"][1]["review"] is None
    assert after["rider"]["review"]["rating"] == 3

    history = w.c.get("/api/v1/orders").json()["data"]
    assert history["items"][0]["myRating"] == 4  # shown in order history

    listed = w.c.get("/api/v1/reviews/mine").json()["data"]
    assert len(listed["items"]) == 3
    assert listed["items"][0]["restaurantName"] == "Spice Route Kitchen"
    assert listed["items"][0]["restaurantSlug"] == "spice-route-kitchen"
    assert listed["pagination"] == {"page": 1, "limit": 10, "total": 3, "totalPages": 1}
    riders = w.c.get("/api/v1/reviews/mine?target=rider").json()["data"]["items"]
    assert [x["target"] for x in riders] == ["rider"]
    assert w.c.get("/api/v1/reviews/mine?target=admin").status_code == 422

    card = w.c.get(f"/api/v1/orders/{order_id}").json()["data"]["order"]
    assert card["rider"]["rating"] == {"average": 3, "count": 1}


def test_lets_the_author_edit_keeping_history_and_delete_and_nobody_else(w: Reviews) -> None:
    order_id = w.delivered_order()
    review_id = w.rate_restaurant(w.c, order_id, 5, "Great").json()["data"]["review"]["id"]

    other = w.second_customer()
    for who in (other, w.o, w.r):
        patch = who.patch(f"/api/v1/reviews/{review_id}", {"rating": 1}, format="json")
        assert patch.status_code in (403, 404)
        assert who.delete(f"/api/v1/reviews/{review_id}").status_code in (403, 404)
    assert other.get(f"/api/v1/reviews/{review_id}").status_code == 404
    assert w.c.get(f"/api/v1/reviews/{review_id}").json()["data"]["review"]["rating"] == 5

    empty = w.c.patch(f"/api/v1/reviews/{review_id}", {}, format="json")
    assert empty.status_code == 422
    assert empty.json()["error"]["details"] == [
        {"field": "", "message": "Change the rating, the comment or the photos"}
    ]

    edited = w.c.patch(
        f"/api/v1/reviews/{review_id}", {"rating": 2, "comment": "Cold on arrival"}, format="json"
    )
    assert edited.status_code == 200
    assert edited.json()["message"] == "Review updated"
    assert edited.json()["data"]["review"]["rating"] == 2
    assert edited.json()["data"]["review"]["editedAt"]
    edits = ReviewEdit.objects.filter(review_id=review_id)
    assert [(e.rating, e.comment) for e in edits] == [(5, "Great")]  # the earlier version is kept
    assert float(restaurant().rating_average) == 2

    Review.objects.filter(pk=review_id).update(created_at=timezone.now() - timedelta(days=31))
    late = w.c.patch(f"/api/v1/reviews/{review_id}", {"rating": 3}, format="json")
    assert late.status_code == 409
    assert late.json()["error"]["code"] == "EDIT_WINDOW_CLOSED"

    deleted = w.c.delete(f"/api/v1/reviews/{review_id}")
    assert deleted.status_code == 200
    assert deleted.json() == {
        "success": True,
        "message": "Review deleted",
        "data": {"deleted": True},
    }
    assert Review.objects.get(pk=review_id).status == "deleted"
    assert restaurant().rating_count == 0  # summary updated
    assert w.rate_restaurant(w.c, order_id, 5).status_code == 409  # deleting is final
    assert w.c.get("/api/v1/reviews/mine").json()["data"]["items"] == []
    assert w.c.get(f"/api/v1/reviews/{review_id}").status_code == 404
    assert w.c.delete(f"/api/v1/reviews/{review_id}").status_code == 404


# --- public lists -------------------------------------------------------------------------------


def test_public_lists_show_published_reviews_with_the_summary(w: Reviews) -> None:
    order_id = w.delivered_order(("Butter Chicken", "Garlic Naan"))
    w.rate_restaurant(w.c, order_id, 2, "Too salty")
    w.review(w.c, orderId=order_id, target="food", foodItemId=w.food_id("Garlic Naan"), rating=5)

    anon = APIClient()
    pub = anon.get("/api/v1/restaurants/spice-route-kitchen/reviews")
    assert pub.status_code == 200
    data = pub.json()["data"]
    assert data["summary"] == {"average": 2, "count": 1, "distribution": [0, 1, 0, 0, 0]}
    assert len(data["items"]) == 1
    item = data["items"][0]
    assert set(item) == {
        "id",
        "target",
        "rating",
        "comment",
        "authorName",
        "foodItem",
        "foodName",
        "images",
        "verifiedOrder",
        "response",
        "createdAt",
        "editedAt",
    }  # no customer id, order or contact details
    assert data["pagination"]["limit"] == 10
    assert "public" in pub["Cache-Control"]
    by_id = anon.get(f"/api/v1/restaurants/{restaurant().pk}/reviews?rating=2&sort=lowest")
    assert len(by_id.json()["data"]["items"]) == 1
    assert (
        anon.get("/api/v1/restaurants/spice-route-kitchen/reviews?rating=5").json()["data"]["items"]
        == []
    )
    assert (
        anon.get("/api/v1/restaurants/spice-route-kitchen/reviews?limit=80").json()["data"][
            "pagination"
        ]["limit"]
        == 50
    )
    assert anon.get("/api/v1/restaurants/spice-route-kitchen/reviews?sort=best").status_code == 422
    assert anon.get("/api/v1/restaurants/nowhere-kitchen/reviews").status_code == 404
    assert anon.get("/api/v1/restaurants/bad%20slug/reviews").status_code == 422

    dish = anon.get(f"/api/v1/foods/{w.food_id('Garlic Naan')}/reviews").json()["data"]
    assert dish["summary"]["average"] == 5
    assert dish["items"][0]["foodName"] == "Garlic Naan"
    missing = anon.get(f"/api/v1/foods/{w.customer['user']['id']}/reviews")
    assert missing.status_code == 404
    assert missing.json()["message"] == "Dish not found"
    assert anon.get("/api/v1/foods/not-an-id/reviews").status_code == 422


def test_shows_riders_their_ratings_and_lets_them_report(w: Reviews) -> None:
    order_id = w.delivered_order()
    created = w.review(w.c, orderId=order_id, target="rider", rating=4, comment="Polite")
    review_id = created.json()["data"]["review"]["id"]
    w.rate_restaurant(w.c, order_id, 1)

    res = w.r.get("/api/v1/delivery/reviews").json()["data"]
    assert res["summary"]["average"] == 4
    assert len(res["items"]) == 1  # only reviews of the rider
    assert res["items"][0]["authorName"] == "Asha Customer"

    patch = w.r.patch(f"/api/v1/reviews/{review_id}", {"rating": 5}, format="json")
    assert patch.status_code == 403

    report = w.r.post(
        f"/api/v1/reviews/{review_id}/reports", {"reason": "harassment"}, format="json"
    )
    assert report.status_code == 201  # riders may report reviews of themselves
    assert report.json()["message"] == "Thanks. Our team will take a look."
    assert report.json()["data"] == {"reported": True}
    other_rider = w.new_rider()
    not_theirs = other_rider.post(
        f"/api/v1/reviews/{review_id}/reports", {"reason": "spam"}, format="json"
    )
    assert not_theirs.status_code == 404
    # The restaurant cannot report the rider's review.
    assert (
        w.o.post(f"/api/v1/reviews/{review_id}/reports", {"reason": "spam"}, format="json")
    ).status_code == 404
    assert w.a.post(f"/api/v1/reviews/{review_id}/reports", {"reason": "spam"}).status_code == 403


# --- reports and moderation ---------------------------------------------------------------------


def test_reports_then_hides_restores_and_removes_with_a_logged_reason(w: Reviews) -> None:
    order_id = w.delivered_order()
    review_id = w.rate_restaurant(w.c, order_id, 1, "Rude staff, call 9000000000").json()["data"][
        "review"
    ]["id"]
    other = w.second_customer()

    def report(who: APIClient, body: dict[str, Any] | None = None) -> Any:
        return who.post(
            f"/api/v1/reviews/{review_id}/reports",
            body or {"reason": "personal_info"},
            format="json",
        )

    own = report(w.c)
    assert own.status_code == 400  # not your own review
    assert own.json()["message"] == "You cannot report your own review"
    nonsense = report(other, {"reason": "nonsense"})
    assert nonsense.status_code == 422
    assert nonsense.json()["error"]["details"][0]["message"].startswith("Reason must be one of:")
    assert report(other, {"reason": "spam", "note": "x" * 301}).status_code == 422
    assert report(other).status_code == 201
    assert report(other).json()["error"]["code"] == "ALREADY_REPORTED"
    assert report(w.o, {"reason": "fake", "note": ""}).status_code == 201
    assert Review.objects.get(pk=review_id).open_reports == 2
    # Admins hear about the first open report only.
    reported = Notification.objects.filter(type="review.reported")
    assert reported.filter(user_id=w.admin["user"]["id"]).count() == 1
    assert (
        reported.first().body
        == f"Order {Order.objects.get(pk=order_id).order_number}: personal info"
    )  # type: ignore[union-attr]

    queue = w.a.get("/api/v1/admin/reviews/orders?reported=true")
    assert queue.status_code == 200
    data = queue.json()["data"]
    assert data["items"][0]["reviews"][0]["id"] == review_id
    assert data["items"][0]["openReports"] == 2
    assert data["counts"] == {"reported": 1}
    for who in (w.c, w.o, w.r):
        assert who.get("/api/v1/admin/reviews/orders").status_code == 403

    def moderate(body: dict[str, Any]) -> Any:
        return w.a.post(f"/api/v1/admin/reviews/{review_id}/moderation", body, format="json")

    no_reason = moderate({"action": "hide"})
    assert no_reason.status_code == 422  # a reason is required
    assert no_reason.json()["error"]["details"] == [
        {"field": "reason", "message": "Record why (customers see this)"}
    ]
    assert moderate({"action": "hide", "reason": " x "}).json()["error"]["details"][0][
        "message"
    ] == ("The reason must be 3 to 300 characters")
    assert moderate({"action": "delete", "reason": "Nope"}).status_code == 422

    hidden = moderate({"action": "hide", "reason": "Contains a phone number"})
    assert hidden.status_code == 200
    assert hidden.json()["message"] == "Review hidden"
    assert hidden.json()["data"]["review"]["status"] == "hidden"
    assert hidden.json()["data"]["review"]["openReports"] == 0  # reports closed as actioned
    assert all(r.status == "actioned" for r in ReviewReport.objects.all())
    assert restaurant().rating_count == 0  # excluded from the average
    audit = AuditLog.objects.get(action="review.moderate")
    assert audit.description == "Review hidden: Contains a phone number"
    assert audit.resource_id == review_id
    moderated = Notification.objects.get(type="review.moderated")
    assert moderated.title == "Your review is hidden while we look into it"
    assert moderated.body == "Reason: Contains a phone number"

    pub = APIClient().get("/api/v1/restaurants/spice-route-kitchen/reviews")
    assert pub.json()["data"]["items"] == []
    assert w.o.get("/api/v1/my/restaurant/reviews/orders").json()["data"]["items"] == []

    own_view = w.c.get(f"/api/v1/reviews/{review_id}").json()["data"]["review"]
    assert own_view["status"] == "hidden"
    assert own_view["moderation"] == {"action": "hide", "reason": "Contains a phone number"}
    assert own_view["editableUntil"] is None
    edit = w.c.patch(f"/api/v1/reviews/{review_id}", {"comment": "Rude staff"}, format="json")
    assert edit.json()["error"]["code"] == "REVIEW_LOCKED"
    assert report(w.second_customer()).status_code == 404  # only published reviews

    assert moderate({"action": "hide", "reason": "again"}).status_code == 200  # a no-op
    restored = moderate({"action": "restore", "reason": "Customer was contacted"})
    assert restored.json()["data"]["review"]["status"] == "published"
    assert restored.json()["message"] == "Review restored"
    assert restaurant().rating_count == 1
    removed = moderate({"action": "remove", "reason": "Policy: personal data"})
    assert removed.json()["data"]["review"]["status"] == "removed"
    invalid = moderate({"action": "hide", "reason": "Not allowed"})
    assert invalid.status_code == 409
    assert invalid.json()["error"]["code"] == "INVALID_MODERATION"
    assert invalid.json()["message"] == "A removed review cannot be hidden"
    assert AuditLog.objects.filter(action="review.moderate").count() == 4  # successes only

    detail = w.a.get(f"/api/v1/admin/reviews/{review_id}").json()["data"]["review"]
    log = detail["moderationLog"]
    assert [(m["action"], m["fromStatus"], m["toStatus"]) for m in log] == [
        ("hide", "published", "hidden"),
        ("restore", "hidden", "published"),
        ("remove", "published", "removed"),
    ]
    assert log[0]["by"]["name"] == "BiteBox Admin"
    assert len(detail["reports"]) == 2
    assert detail["reports"][0]["reporterName"] == "Spice Route Owner"  # newest first
    assert detail["comment"] == "Rude staff, call 9000000000"  # admins never rewrite the words
    assert detail["customer"] == {
        "id": w.customer["user"]["id"],
        "name": "Asha Customer",
        "email": "customer@bitebox.test",
    }
    assert detail["restaurant"]["slug"] == "spice-route-kitchen"
    assert detail["moderation"]["action"] == "remove"
    assert "response" not in detail
    assert "foodName" not in detail
    # There is no admin edit endpoint.
    assert (
        w.a.patch(f"/api/v1/admin/reviews/{review_id}", {"comment": "edited"}, format="json")
    ).status_code in (404, 405)
    assert w.a.get(f"/api/v1/admin/reviews/{w.customer['user']['id']}").status_code == 404


def test_dismisses_reports_without_changing_the_review(w: Reviews) -> None:
    order_id = w.delivered_order()
    review_id = w.rate_restaurant(w.c, order_id, 3, "Average").json()["data"]["review"]["id"]
    w.second_customer().post(
        f"/api/v1/reviews/{review_id}/reports", {"reason": "spam"}, format="json"
    )
    res = w.a.post(
        f"/api/v1/admin/reviews/{review_id}/reports/dismiss",
        {"reason": "Honest opinion"},
        format="json",
    )
    assert res.status_code == 200
    assert res.json()["message"] == "Reports dismissed"
    review = res.json()["data"]["review"]
    assert review["status"] == "published"
    assert review["openReports"] == 0
    assert review["reports"][0]["status"] == "dismissed"
    assert review["reports"][0]["resolvedBy"] == "BiteBox Admin"
    assert review["moderationLog"][0]["action"] == "dismiss_reports"
    again = w.a.post(
        f"/api/v1/admin/reviews/{review_id}/reports/dismiss", {"reason": "Again"}, format="json"
    )
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "NO_OPEN_REPORTS"
    missing = w.a.post(f"/api/v1/admin/reviews/{review_id}/reports/dismiss", {}, format="json")
    assert missing.json()["error"]["details"] == [{"field": "reason", "message": "Give a reason"}]


# --- aggregation --------------------------------------------------------------------------------


def test_keeps_averages_counts_and_distributions_exact(w: Reviews) -> None:
    ids = []
    for rating in (5, 4, 1, 4):
        order_id = w.delivered_order()
        ids.append(w.rate_restaurant(w.c, order_id, rating).json()["data"]["review"]["id"])
    rest = restaurant()
    assert (rest.rating_count, float(rest.rating_average)) == (4, 3.5)
    assert rest.rating_distribution == [1, 0, 0, 2, 1]

    w.a.post(
        f"/api/v1/admin/reviews/{ids[2]}/moderation",
        {"action": "remove", "reason": "Spam"},
        format="json",
    )
    w.c.patch(f"/api/v1/reviews/{ids[0]}", {"rating": 3}, format="json")
    rest = restaurant()
    assert rest.rating_count == 3
    assert float(rest.rating_average) == 3.67  # (3 + 4 + 4) / 3, rounded to 2 places
    assert rest.rating_distribution == [0, 0, 1, 2, 0]

    # A drifted cache is repaired by the next refresh.
    Restaurant.objects.filter(pk=rest.pk).update(rating_count=99)
    refresh_rating("restaurant", rest.pk)
    assert restaurant().rating_count == 3

    res = w.a.get("/api/v1/admin/reviews/analytics?days=7")
    assert res.status_code == 200
    a = res.json()["data"]
    assert a["days"] == 7
    assert a["targets"]["restaurant"]["count"] == 3
    assert a["targets"]["restaurant"]["average"] == 3.67
    assert a["targets"]["food"] == {"average": 0, "count": 0, "distribution": [0, 0, 0, 0, 0]}
    assert a["newReviews"] == 4  # removed reviews still count as written
    assert len(a["daily"]) == 7
    assert a["daily"][-1]["reviews"] == 4
    assert a["daily"][-1]["averageRating"] == 3  # (3 + 4 + 1 + 4) / 4: current ratings
    assert a["statusCounts"] == {"published": 3, "removed": 1}
    assert a["moderationActions"] == {"remove": 1}
    assert a["openReports"] == 0
    assert a["reportReasons"] == []
    assert a["restaurants"]["top"][0]["name"] == "Spice Route Kitchen"
    assert a["riders"] == {"top": [], "bottom": []}  # no rider has 3 ratings
    assert a["minReviewsToRank"] == 3
    assert w.a.get("/api/v1/admin/reviews/analytics").json()["data"]["days"] == 30
    assert w.a.get("/api/v1/admin/reviews/analytics?days=0").status_code == 422


def test_dismissed_reports_keep_their_action_key_in_the_analytics(w: Reviews) -> None:
    order_id = w.delivered_order()
    review_id = w.rate_restaurant(w.c, order_id, 2).json()["data"]["review"]["id"]
    w.second_customer().post(
        f"/api/v1/reviews/{review_id}/reports", {"reason": "personal_info"}, format="json"
    )
    w.a.post(
        f"/api/v1/admin/reviews/{review_id}/reports/dismiss", {"reason": "Fine"}, format="json"
    )
    a = w.a.get("/api/v1/admin/reviews/analytics").json()["data"]
    assert a["moderationActions"] == {"dismiss_reports": 1}
    assert a["reportReasons"] == [{"reason": "personal_info", "count": 1}]


# --- rate your experience -----------------------------------------------------------------------


def test_rates_restaurant_every_dish_and_the_rider_in_one_submission_with_photos(
    w: Reviews,
) -> None:
    order_id = w.delivered_order(("Butter Chicken", "Garlic Naan"))
    photos = []
    for _ in range(2):
        res = w.upload(w.c)
        assert res.status_code == 201, res.json()
        photos.append(res.json()["data"]["url"])
    res = w.rate_order(
        w.c, order_id, restaurant=5, food=4, rider=5, comment="Hot and on time", images=photos
    )
    assert res.status_code == 201, res.json()
    assert res.json()["message"] == "Thanks for rating your order"
    state = res.json()["data"]
    assert state["restaurant"]["review"]["rating"] == 5
    assert state["restaurant"]["review"]["images"] == photos
    assert [i["review"]["rating"] for i in state["items"]] == [4, 4]
    assert state["items"][0]["review"]["comment"] == ""  # the words go on the restaurant review
    assert state["rider"]["review"]["rating"] == 5
    assert Review.objects.count() == 4
    assert float(FoodItem.objects.get(name="Garlic Naan").rating_average) == 4
    # One notification per party, not one per dish.
    owner_notes = Notification.objects.filter(type="review.new", user_id=w.owner["user"]["id"])
    assert list(owner_notes.values_list("title", flat=True)) == ["New 5★ review"]

    pub = APIClient().get("/api/v1/restaurants/spice-route-kitchen/reviews").json()["data"]
    assert pub["items"][0]["images"] == photos

    again = w.rate_order(w.c, order_id, rider=1)
    assert again.json()["error"]["code"] == "DUPLICATE_REVIEW"
    assert again.json()["message"] == "You have already rated the delivery"


def test_rating_an_order_is_all_or_nothing(w: Reviews) -> None:
    order_id = w.delivered_order(("Butter Chicken", "Garlic Naan"))
    w.rate_restaurant(w.c, order_id, 3)
    # The restaurant part is a duplicate, so neither dish nor rider ratings are saved.
    res = w.rate_order(w.c, order_id, restaurant=5, food=5, rider=5)
    assert res.status_code == 409
    assert Review.objects.count() == 1
    # Food quality skips dishes already rated.
    w.review(w.c, orderId=order_id, target="food", foodItemId=w.food_id("Butter Chicken"), rating=2)
    ok = w.rate_order(w.c, order_id, food=5)
    assert ok.status_code == 201
    assert [i["review"]["rating"] for i in ok.json()["data"]["items"]] == [2, 5]
    food_note = Notification.objects.filter(type="review.new", title="New 5★ food rating")
    assert food_note.count() == 1
    assert w.rate_order(w.c, order_id, food=4).json()["message"] == (
        "You have already rated every dish"
    )


def test_validates_the_submission_and_only_accepts_bitebox_hosted_photos(w: Reviews) -> None:
    order_id = w.delivered_order()
    bodies: list[dict[str, Any]] = [
        {},
        {"restaurant": 6},
        {"food": 4, "comment": "words need a restaurant rating"},
        {"restaurant": 4, "images": ["https://example.com/cat.png"]},
        {"restaurant": 4, "images": ["x"] * 6},
        {"restaurant": 4, "images": "not a list"},
    ]
    for body in bodies:
        res = w.rate_order(w.c, order_id, **body)
        assert res.status_code == 422, body
    assert w.rate_order(w.c, order_id).json()["error"]["details"] == [
        {"field": "", "message": "Rate at least one part of the order"}
    ]
    assert w.rate_order(w.c, order_id, food=4, comment="Nice").json()["error"]["details"] == [
        {"field": "", "message": "Rate the restaurant to add a review or photos"}
    ]
    hosted = w.rate_order(w.c, order_id, restaurant=4, images=["https://example.com/cat.png"])
    assert hosted.json()["error"]["details"] == [
        {"field": "images[0]", "message": "Upload photos through BiteBox"}
    ]
    photo = w.upload(w.c).json()["data"]["url"]
    single = w.review(w.c, orderId=order_id, target="rider", rating=4, images=[photo])
    assert single.status_code == 422  # no photos on delivery ratings
    assert single.json()["error"]["details"] == [
        {"field": "images", "message": "Delivery ratings don't take photos"}
    ]
    assert Review.objects.count() == 0
    assert w.rate_order(w.c, "not-an-id", restaurant=4).status_code == 422
    other = w.second_customer()
    assert w.rate_order(other, order_id, restaurant=4).status_code == 404

    assert w.upload(w.o).status_code == 403  # customers only
    not_image = io.BytesIO(b"not an image")
    not_image.name = "x.png"
    res = w.c.post("/api/v1/uploads/review-images", {"image": not_image}, format="multipart")
    assert res.status_code == 415


def test_keeps_earlier_photos_in_the_edit_history(w: Reviews) -> None:
    order_id = w.delivered_order()
    first = w.upload(w.c).json()["data"]["url"]
    second = w.upload(w.c).json()["data"]["url"]
    r = w.review(w.c, orderId=order_id, target="restaurant", rating=4, images=[first])
    review_id = r.json()["data"]["review"]["id"]
    edited = w.c.patch(f"/api/v1/reviews/{review_id}", {"images": [second]}, format="json")
    assert edited.status_code == 200
    assert edited.json()["data"]["review"]["images"] == [second]
    assert ReviewEdit.objects.get(review_id=review_id).images == [first]
    # Unchanged edits keep no history.
    same = w.c.patch(f"/api/v1/reviews/{review_id}", {"images": [second]}, format="json")
    assert same.status_code == 200
    assert ReviewEdit.objects.filter(review_id=review_id).count() == 1


# --- grouped by order ---------------------------------------------------------------------------


def test_groups_reviews_by_order_for_the_restaurant_and_the_admin(w: Reviews) -> None:
    first = w.delivered_order(("Butter Chicken", "Garlic Naan"))
    w.rate_order(w.c, first, restaurant=4, food=5, rider=3, comment="Good overall")
    second = w.delivered_order()
    flagged = w.rate_restaurant(w.c, second, 1, "Bad").json()["data"]["review"]["id"]
    w.second_customer().post(
        f"/api/v1/reviews/{flagged}/reports", {"reason": "spam"}, format="json"
    )

    rows = w.o.get("/api/v1/my/restaurant/reviews/orders").json()["data"]
    assert len(rows["items"]) == 2  # one row per order
    row = next(r for r in rows["items"] if r["order"] == first)
    assert [(r["target"], r["foodName"]) for r in row["reviews"]] == [
        ("restaurant", None),
        ("food", "Butter Chicken"),
        ("food", "Garlic Naan"),
    ]  # restaurant first, then dishes; never the rider
    assert row["unanswered"] == 3

    queue = w.a.get("/api/v1/admin/reviews/orders?reported=true").json()["data"]
    assert len(queue["items"]) == 1
    assert queue["items"][0]["order"] == second
    assert queue["items"][0]["openReports"] == 1
    assert queue["counts"]["reported"] == 1

    all_rows = w.a.get("/api/v1/admin/reviews/orders").json()["data"]
    assert len(all_rows["items"]) == 2
    assert all_rows["items"][0]["order"] == second  # newest first
    first_row = next(r for r in all_rows["items"] if r["order"] == first)
    assert first_row["restaurant"] == {"id": str(restaurant().pk), "name": "Spice Route Kitchen"}
    assert first_row["customerName"] == "Asha Customer"
    assert [r["target"] for r in first_row["reviews"]] == ["restaurant", "food", "food", "rider"]
    rider_review = first_row["reviews"][-1]
    assert rider_review["deliveryPartner"] == {"id": w.rider["user"]["id"], "name": "Ravi Rider"}
    assert rider_review["customer"] == w.customer["user"]["id"]

    searched = w.a.get("/api/v1/admin/reviews/orders?search=garlic").json()["data"]
    assert [r["order"] for r in searched["items"]] == [first]
    rider_only = w.a.get("/api/v1/admin/reviews/orders?target=rider&rating=3").json()["data"]
    assert [r["order"] for r in rider_only["items"]] == [first]
    assert w.a.get("/api/v1/admin/reviews/orders?status=gone").status_code == 422
    assert w.a.get("/api/v1/admin/reviews/orders?restaurantId=x").status_code == 422

    detail = w.a.get(f"/api/v1/admin/reviews/orders/{first}").json()["data"]
    assert [r["target"] for r in detail["reviews"]] == ["restaurant", "food", "food", "rider"]
    assert isinstance(detail["reviews"][0]["moderationLog"], list)
    assert detail["reviews"][0]["edits"] == []
    assert w.o.get(f"/api/v1/admin/reviews/orders/{first}").status_code == 403
    missing = w.a.get(f"/api/v1/admin/reviews/orders/{w.customer['user']['id']}")
    assert missing.status_code == 404
    assert missing.json()["message"] == "No reviews for this order"


def test_support_admins_moderate_but_finance_admins_cannot() -> None:
    support = client_for(create_and_login("support_admin")["token"])
    finance = client_for(create_and_login("finance_admin")["token"])
    assert support.get("/api/v1/admin/reviews/orders").status_code == 200
    assert finance.get("/api/v1/admin/reviews/orders").status_code == 403
