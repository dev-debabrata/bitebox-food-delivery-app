"""
Reviews (Node: services/review.service.js): rating summaries, the customer's reviews (writing,
editing, deleting, reporting), the public lists, the restaurant panel and the rider's list.
Admin moderation and analytics are in `moderation.py`.
"""

import uuid
from datetime import datetime, timedelta
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Avg, Count, Max, Min, QuerySet, Sum
from django.utils import timezone

from apps.accounts.models import User
from apps.cart.pricing import js_round
from apps.delivery.models import DeliveryPartner
from apps.finance.models import OrderSettlement
from apps.menus.models import FoodItem
from apps.notifications.services import notify, notify_admins
from apps.orders.models import Order, OrderStatus, OrderStatusHistory
from apps.rbac.roles import Permission, Role
from apps.restaurants.models import Restaurant
from apps.restaurants.presenters import rating_json
from common.api import ApiError
from common.pagination import Page, paginate

from . import rewards
from .models import (
    EDIT_WINDOW_DAYS,
    SUBMIT_WINDOW_DAYS,
    ReportStatus,
    Review,
    ReviewEdit,
    ReviewReport,
    ReviewResponse,
    ReviewStatus,
    ReviewTarget,
)

T = ReviewTarget


def summarize(counts: dict[int, int]) -> dict[str, Any]:
    """{stars: n} → average (2 decimals, halves up like Node), count and the 1–5 distribution."""
    distribution = [counts.get(stars, 0) for stars in range(1, 6)]
    count = sum(distribution)
    total = sum(n * (i + 1) for i, n in enumerate(distribution))
    average = js_round(total / count * 100) / 100 if count else 0
    return {"average": average, "count": count, "distribution": distribution}


def refresh_rating(target: str, subject_id: Any) -> dict[str, Any] | None:
    """
    Rebuilds a subject's cached rating from its published reviews (never by adding deltas), so it
    cannot drift. Every review create, edit, delete and moderation calls it.
    """
    if not subject_id:
        return None
    subjects: dict[str, tuple[str, QuerySet[Any], str]] = {
        T.RESTAURANT: ("restaurant_id", Restaurant.objects.all(), "pk"),
        T.FOOD: ("food_item_id", FoodItem.objects.all(), "pk"),
        T.RIDER: ("delivery_partner_id", DeliveryPartner.objects.all(), "user_id"),
    }
    field, subjects_qs, key = subjects[target]
    rows = (
        Review.objects.filter(target=target, status=ReviewStatus.PUBLISHED, **{field: subject_id})
        .values("rating")
        .annotate(n=Count("pk"))
        .order_by()
    )
    rating = summarize({r["rating"]: r["n"] for r in rows})
    subjects_qs.filter(**{key: subject_id}).update(
        rating_average=rating["average"],
        rating_count=rating["count"],
        rating_distribution=rating["distribution"],
    )
    return rating


SUBJECT_FIELD: dict[str, str] = {
    T.RESTAURANT: "restaurant_id",
    T.FOOD: "food_item_id",
    T.RIDER: "delivery_partner_id",
}


def refresh_for(review: Review) -> dict[str, Any] | None:
    return refresh_rating(review.target, getattr(review, SUBJECT_FIELD[review.target]))


def review_changed() -> ApiError:
    return ApiError(409, "This review just changed. Reload and try again.", code="REVIEW_CHANGED")


def short_name(name: str | None) -> str:
    return (name or "").strip() or "Customer"


def _response(review: Review) -> ReviewResponse | None:
    try:
        return review.response
    except ReviewResponse.DoesNotExist:
        return None


def response_view(review: Review) -> dict[str, Any] | None:
    r = _response(review)
    if r is None or not r.text:
        return None
    return {"text": r.text, "responded_at": r.responded_at, "updated_at": r.updated_at}


def present_public(review: Review) -> dict[str, Any]:
    """What anyone may see: no customer id, order or contact details."""
    return {
        "id": str(review.pk),
        "target": review.target,
        "rating": review.rating,
        "comment": review.comment,
        "author_name": short_name(review.customer_name),
        "food_item": str(review.food_item_id) if review.food_item_id else None,
        "food_name": review.food_name or None,
        "images": list(review.images or []),
        "verified_order": True,
        "response": response_view(review),
        "created_at": review.created_at,
        "edited_at": review.edited_at,
    }


def editable_until(review: Review) -> datetime | None:
    if review.status != ReviewStatus.PUBLISHED:
        return None
    return review.created_at + timedelta(days=EDIT_WINDOW_DAYS)


def present_for_customer(review: Review) -> dict[str, Any]:
    """The author's own view, including why a review was hidden or removed."""
    moderated = review.status in (ReviewStatus.HIDDEN, ReviewStatus.REMOVED)
    return {
        **present_public(review),
        "status": review.status,
        "order": str(review.order_id),
        "order_number": review.order_number,
        "restaurant": str(review.restaurant_id),
        "delivery_partner": str(review.delivery_partner_id) if review.delivery_partner_id else None,
        "moderation": (
            {"action": review.moderation_action or None, "reason": review.moderation_reason}
            if moderated
            else None
        ),
        "editable_until": editable_until(review),
    }


def present_for_restaurant(review: Review, reported: set[str]) -> dict[str, Any]:
    return {
        **present_public(review),
        "order_number": review.order_number,
        "reported_by_you": str(review.pk) in reported,
    }


def _reported_by(user: User, reviews: list[Review]) -> set[str]:
    ids = ReviewReport.objects.filter(
        reporter=user, review__in=[r.pk for r in reviews]
    ).values_list("review_id", flat=True)
    return {str(i) for i in ids}


# Restaurant first, then dishes by name, then the rider (the rows and dialogs use this order).
_TARGET_ORDER: dict[str, int] = {T.RESTAURANT: 0, T.FOOD: 1, T.RIDER: 2}


def _by_target(r: Review) -> tuple[int, str]:
    return (_TARGET_ORDER.get(r.target, 9), r.food_name or "")


def order_group(order_id: Any, reviews: list[Review]) -> dict[str, Any]:
    reviews.sort(key=_by_target)
    return {
        "order": str(order_id),
        "order_number": reviews[0].order_number,
        "customer_name": reviews[0].customer_name,
        "created_at": max(r.created_at for r in reviews),
        "reviews": reviews,
    }


def group_reviews(order_ids: list[Any], reviews: list[Review]) -> list[dict[str, Any]]:
    """Loaded reviews grouped per order, in `order_ids` order (orders without any are skipped)."""
    by_order: dict[Any, list[Review]] = {oid: [] for oid in order_ids}
    for r in reviews:
        by_order.setdefault(r.order_id, []).append(r)
    return [order_group(oid, rows) for oid, rows in by_order.items() if rows]


GROUP_SORTS = {
    "newest": ("-last_at", "-order_id"),
    "oldest": ("first_at", "order_id"),
    "highest": ("-average", "-last_at", "-order_id"),
    "lowest": ("average", "-last_at", "-order_id"),
    "reported": ("-open", "-last_at", "-order_id"),
}


def order_page(
    match: QuerySet[Review], sort: str | None, page: Page
) -> tuple[list[Any], dict[str, int]]:
    """The page of order ids whose reviews match, in `sort` order."""
    groups = (
        match.values("order_id")
        .annotate(
            first_at=Min("created_at"),
            last_at=Max("created_at"),
            average=Avg("rating"),
            open=Sum("open_reports"),
        )
        .order_by(*GROUP_SORTS.get(sort or "newest", GROUP_SORTS["newest"]))
    )
    total = groups.count()
    ids = [g["order_id"] for g in groups[page.offset : page.offset + page.limit]]
    return ids, page.meta(total)


# ---------------------------------------------------------------------------
# Restaurant
# ---------------------------------------------------------------------------
def _own_restaurant(owner: User) -> Restaurant:
    restaurant = Restaurant.objects.filter(owner=owner).first()
    if restaurant is None:
        raise ApiError.not_found("Create your restaurant first")
    return restaurant


def _restaurant_reviews(
    restaurant: Restaurant, query: dict[str, Any] | None = None
) -> QuerySet[Review]:
    """What a restaurant may see: published reviews of it and its dishes, never the rider's."""
    query = query or {}
    qs = Review.objects.filter(restaurant=restaurant, status=ReviewStatus.PUBLISHED)
    qs = (
        qs.filter(target=query["target"])
        if query.get("target")
        else qs.filter(target__in=[T.RESTAURANT, T.FOOD])
    )
    if query.get("food_item_id"):
        qs = qs.filter(food_item_id=query["food_item_id"])
    if query.get("rating"):
        qs = qs.filter(rating=query["rating"])
    if query.get("responded") is True:
        qs = qs.filter(response__isnull=False)
    elif query.get("responded") is False:
        qs = qs.filter(response__isnull=True)
    return qs


def _restaurant_order_view(group: dict[str, Any], reported: set[str]) -> dict[str, Any]:
    reviews: list[Review] = group.pop("reviews")
    customer_name = group.pop("customer_name")
    return {
        **group,
        "author_name": short_name(customer_name),
        "unanswered": sum(1 for r in reviews if response_view(r) is None),
        "reviews": [present_for_restaurant(r, reported) for r in reviews],
    }


def restaurant_orders(owner: User, query: dict[str, Any], page: Page) -> dict[str, Any]:
    """One row per order: its restaurant and dish reviews together."""
    restaurant = _own_restaurant(owner)
    order_ids, meta = order_page(_restaurant_reviews(restaurant, query), query.get("sort"), page)
    reviews = list(
        _restaurant_reviews(restaurant).filter(order_id__in=order_ids).select_related("response")
    )
    reported = _reported_by(owner, reviews)
    items = [_restaurant_order_view(g, reported) for g in group_reviews(order_ids, reviews)]
    return {"items": items, "pagination": meta}


def restaurant_order(owner: User, order_id: uuid.UUID) -> dict[str, Any]:
    """Every review of one order (restaurant and dishes), for the order dialog."""
    restaurant = _own_restaurant(owner)
    reviews = list(
        _restaurant_reviews(restaurant).filter(order_id=order_id).select_related("response")
    )
    if not reviews:
        raise ApiError.not_found("No reviews for this order")
    return _restaurant_order_view(order_group(order_id, reviews), _reported_by(owner, reviews))


def restaurant_summary(owner: User) -> dict[str, Any]:
    """The restaurant's rating plus every dish's, for the summary cards and the dish filter."""
    restaurant = _own_restaurant(owner)
    foods = FoodItem.objects.filter(restaurant=restaurant, deleted_at__isnull=True).order_by(
        "-rating_count", "name"
    )
    return {
        "rating": rating_json(restaurant),
        "unanswered": _restaurant_reviews(restaurant, {"responded": False}).count(),
        "foods": [{"id": str(f.pk), "name": f.name, "rating": rating_json(f)} for f in foods],
    }


def _own_restaurant_review(owner: User, review_id: uuid.UUID) -> tuple[Restaurant, Review]:
    restaurant = _own_restaurant(owner)
    review = _restaurant_reviews(restaurant).filter(pk=review_id).select_related("response").first()
    if review is None:
        raise ApiError.not_found("Review not found")
    return restaurant, review


def respond(owner: User, review_id: uuid.UUID, text: str) -> dict[str, Any]:
    """A public reply. It sits beside the review and never changes the customer's words."""
    restaurant, review = _own_restaurant_review(owner, review_id)
    with transaction.atomic():
        locked = (
            Review.objects.select_for_update()
            .filter(pk=review.pk, status=ReviewStatus.PUBLISHED)
            .first()
        )
        if locked is None:
            raise ApiError.not_found("Review not found")
        existing = ReviewResponse.objects.filter(review=locked).first()
        if existing:
            existing.text = text
            existing.save(update_fields=["text", "updated_at"])
        else:
            ReviewResponse.objects.create(review=locked, text=text)
    if existing is None:
        notify(
            review.customer_id,
            type="review.response",
            title=f"{restaurant.name} replied to your review",
            body=text[:140],
            link=f"/orders/{review.order_id}",
        )
    fresh = Review.objects.select_related("response").get(pk=review.pk)
    return present_for_restaurant(fresh, _reported_by(owner, [fresh]))


def delete_response(owner: User, review_id: uuid.UUID) -> dict[str, Any]:
    _, review = _own_restaurant_review(owner, review_id)
    ReviewResponse.objects.filter(review=review).delete()
    fresh = Review.objects.select_related("response").get(pk=review.pk)
    return present_for_restaurant(fresh, _reported_by(owner, [fresh]))


# ---------------------------------------------------------------------------
# Rider
# ---------------------------------------------------------------------------
REVIEW_SORTS = {
    "newest": ("-created_at", "-id"),
    "oldest": ("created_at", "id"),
    "highest": ("-rating", "-created_at", "-id"),
    "lowest": ("rating", "-created_at", "-id"),
}


def present_for_rider(review: Review, reported: set[str]) -> dict[str, Any]:
    """Riders see the rating and words, the author's name and the order number. Nothing else."""
    return {
        "id": str(review.pk),
        "rating": review.rating,
        "comment": review.comment,
        "author_name": short_name(review.customer_name),
        "order_number": review.order_number,
        "created_at": review.created_at,
        "edited_at": review.edited_at,
        "reported_by_you": str(review.pk) in reported,
    }


def rider_list(user: User, query: dict[str, Any], page: Page) -> dict[str, Any]:
    qs = Review.objects.filter(target=T.RIDER, delivery_partner=user, status=ReviewStatus.PUBLISHED)
    if query.get("rating"):
        qs = qs.filter(rating=query["rating"])
    qs = qs.order_by(*REVIEW_SORTS.get(query.get("sort") or "newest", REVIEW_SORTS["newest"]))
    total = qs.count()
    items = list(qs[page.offset : page.offset + page.limit])
    profile = DeliveryPartner.objects.filter(user=user).first()
    summary = (
        rating_json(profile)
        if profile
        else {"average": 0, "count": 0, "distribution": [0, 0, 0, 0, 0]}
    )
    reported = _reported_by(user, items)
    return {
        "summary": summary,
        "items": [present_for_rider(r, reported) for r in items],
        "pagination": page.meta(total),
    }


def _sorted(qs: QuerySet[Review], sort: str | None) -> QuerySet[Review]:
    return qs.order_by(*REVIEW_SORTS.get(sort or "newest", REVIEW_SORTS["newest"]))


# ---------------------------------------------------------------------------
# Customer: eligibility
# ---------------------------------------------------------------------------
def _delivered_at(order: Order) -> datetime:
    at = (
        OrderStatusHistory.objects.filter(order=order, to_status=OrderStatus.DELIVERED)
        .order_by("-created_at")
        .values_list("created_at", flat=True)
        .first()
    )
    if at is None:
        at = (
            OrderSettlement.objects.filter(order=order).values_list("settled_at", flat=True).first()
        )
    return at or order.updated_at


def _own_order(user: User, order_id: uuid.UUID) -> Order:
    """Loaded with the customer in the filter: the order id from the client is not trusted."""
    order = Order.objects.filter(pk=order_id, customer=user).first()
    if order is None:
        raise ApiError.not_found("Order not found")
    return order


def _review_window(order: Order, now: datetime | None = None) -> dict[str, Any]:
    if order.status != OrderStatus.DELIVERED:
        return {
            "open": False,
            "closes_at": None,
            "code": "ORDER_NOT_DELIVERED",
            "reason": "You can review an order once it has been delivered",
        }
    closes_at = _delivered_at(order) + timedelta(days=SUBMIT_WINDOW_DAYS)
    if (now or timezone.now()) > closes_at:
        return {
            "open": False,
            "closes_at": closes_at,
            "code": "REVIEW_WINDOW_CLOSED",
            "reason": f"Reviews can be written up to {SUBMIT_WINDOW_DAYS} days after delivery",
        }
    return {"open": True, "closes_at": closes_at, "code": None, "reason": None}


def _assert_open(order: Order) -> None:
    window = _review_window(order)
    if not window["open"]:
        raise ApiError(409, window["reason"], code=window["code"])


def _same_subject(target: str, food_item: Any, other_target: str, other_food: Any) -> bool:
    return target == other_target and str(food_item or "") == str(other_food or "")


def _order_items(order: Order) -> list[Any]:
    return list(order.items.order_by("created_at", "id"))


def _order_state(order: Order, reviews: list[Review]) -> dict[str, Any]:
    """What can be reviewed on the order and what this customer already did."""
    window = _review_window(order)

    def find(target: str, food_item: Any = None) -> dict[str, Any] | None:
        match = next(
            (r for r in reviews if _same_subject(r.target, r.food_item_id, target, food_item)),
            None,
        )
        return present_for_customer(match) if match else None

    return {
        "order_id": str(order.pk),
        "can_review": window["open"],
        "reason": window["reason"],
        "closes_at": window["closes_at"],
        "restaurant": {
            "id": str(order.restaurant_id),
            "name": (order.restaurant_snapshot or {}).get("name"),
            "review": find(T.RESTAURANT),
        },
        "items": [
            {
                "food_item": str(i.food_item_id),
                "name": i.name,
                "review": find(T.FOOD, i.food_item_id),
            }
            for i in _order_items(order)
        ],
        "rider": {"review": find(T.RIDER)} if order.delivery_partner_id else None,
    }


def _orders_reviews(order: Order, user: User) -> list[Review]:
    if order.status != OrderStatus.DELIVERED:
        return []
    return list(Review.objects.filter(order=order, customer=user).select_related("response"))


def order_reviews(user: User, order_id: uuid.UUID) -> dict[str, Any]:
    """Everything the "Rate your order" dialog needs: what can be reviewed and what already was."""
    order = _own_order(user, order_id)
    return _order_state(order, _orders_reviews(order, user))


# ---------------------------------------------------------------------------
# Customer: writing
# ---------------------------------------------------------------------------
def _build_review(
    user: User,
    order: Order,
    *,
    target: str,
    rating: int,
    food_item_id: Any = None,
    comment: str | None = None,
    images: list[str] | None = None,
) -> Review:
    """The (unsaved) review of one part of an already loaded and checked order."""
    review = Review(
        target=target,
        customer=user,
        customer_name=(user.name or "")[:80],
        order=order,
        order_number=order.order_number,
        restaurant_id=order.restaurant_id,
        rating=rating,
        comment=comment or "",
        images=list(images or []),
    )
    if target == T.FOOD:
        line = next(
            (i for i in _order_items(order) if str(i.food_item_id) == str(food_item_id)), None
        )
        if line is None:
            raise ApiError(
                422,
                "That dish was not part of this order",
                code="VALIDATION_ERROR",
                details=[{"field": "foodItemId", "message": "Not in this order"}],
            )
        review.food_item_id = line.food_item_id
        review.food_name = line.name
    if target == T.RIDER:
        if not order.delivery_partner_id:
            raise ApiError(409, "This order had no delivery partner", code="NO_RIDER")
        review.delivery_partner_id = order.delivery_partner_id
    return review


def _insert(reviews: list[Review]) -> None:
    """All or nothing; the unique constraints turn a repeat (or a racing double submit) into 409."""
    try:
        with transaction.atomic():
            for review in reviews:
                review.save()
    except IntegrityError:
        raise ApiError(409, "You have already reviewed this", code="DUPLICATE_REVIEW") from None


def _notify_new_review(review: Review, title: str | None = None) -> None:
    rider = review.target == T.RIDER
    recipient = (
        review.delivery_partner_id
        if rider
        else Restaurant.objects.filter(pk=review.restaurant_id)
        .values_list("owner_id", flat=True)
        .first()
    )
    notify(
        recipient,
        type="review.new",
        title=title or f"New {review.rating}★ {'delivery rating' if rider else 'review'}",
        body=(
            f"{review.food_name}, order {review.order_number}"
            if review.target == T.FOOD and not title
            else f"Order {review.order_number}"
        ),
        link="/delivery/reviews" if rider else "/restaurant/reviews",
    )


def create(user: User, data: dict[str, Any]) -> dict[str, Any]:
    order = _own_order(user, data["order_id"])
    _assert_open(order)
    review = _build_review(
        user,
        order,
        target=data["target"],
        rating=data["rating"],
        food_item_id=data.get("food_item_id"),
        comment=data.get("comment"),
        images=data.get("images"),
    )
    _insert([review])
    refresh_for(review)
    _notify_new_review(review)
    return present_for_customer(review)


# Restaurant and rider: one review each. Food: every dish not yet rated.
ORDER_PARTS = (
    ("restaurant", T.RESTAURANT, "You have already rated the restaurant"),
    ("food", T.FOOD, "You have already rated every dish"),
    ("rider", T.RIDER, "You have already rated the delivery"),
)


def review_order(user: User, order_id: uuid.UUID, data: dict[str, Any]) -> dict[str, Any]:
    """
    "Rate your experience" in one go: the restaurant (with the words and photos), every dish not
    yet rated (food quality) and the rider. All or nothing.
    """
    order = _own_order(user, order_id)
    _assert_open(order)
    existing = list(Review.objects.filter(order=order).values_list("target", "food_item_id"))

    def done(target: str, food_item: Any = None) -> bool:
        return any(_same_subject(t, f, target, food_item) for t, f in existing)

    parts: list[Review] = []
    for key, target, message in ORDER_PARTS:
        rating = data.get(key)
        if rating is None:
            continue
        subjects: list[Any] = (
            [i.food_item_id for i in _order_items(order) if not done(T.FOOD, i.food_item_id)]
            if target == T.FOOD
            else ([] if done(target) else [None])
        )
        if not subjects:
            raise ApiError(409, message, code="DUPLICATE_REVIEW")
        words = target == T.RESTAURANT
        parts.extend(
            _build_review(
                user,
                order,
                target=target,
                rating=rating,
                food_item_id=subject,
                comment=data.get("comment") if words else None,
                images=data.get("images") if words else None,
            )
            for subject in subjects
        )
    _insert(parts)
    rewards.reviews_posted(order, parts)

    # Each created review is a different subject; one notification per party, not per dish.
    for review in parts:
        refresh_for(review)
    for_restaurant = next((r for r in parts if r.target != T.RIDER), None)
    for_rider = next((r for r in parts if r.target == T.RIDER), None)
    if for_restaurant:
        title = (
            f"New {data['restaurant']}★ review"
            if data.get("restaurant") is not None
            else f"New {data['food']}★ food rating"
        )
        _notify_new_review(for_restaurant, title)
    if for_rider:
        _notify_new_review(for_rider)
    return _order_state(order, _orders_reviews(order, user))


# ---------------------------------------------------------------------------
# Customer: their reviews
# ---------------------------------------------------------------------------
def list_mine(user: User, query: dict[str, Any], page: Page) -> dict[str, Any]:
    qs = Review.objects.filter(customer=user).exclude(status=ReviewStatus.DELETED)
    if query.get("target"):
        qs = qs.filter(target=query["target"])
    qs = _sorted(qs.select_related("restaurant", "response"), query.get("sort"))
    items, meta = paginate(qs, page)
    return {
        "items": [
            {
                **present_for_customer(r),
                "restaurant_name": r.restaurant.name,
                "restaurant_slug": r.restaurant.slug,
            }
            for r in items
        ],
        "pagination": meta,
    }


def _own_review(user: User, review_id: uuid.UUID) -> Review:
    review = (
        Review.objects.filter(pk=review_id, customer=user)
        .exclude(status=ReviewStatus.DELETED)
        .select_related("response")
        .first()
    )
    if review is None:
        raise ApiError.not_found("Review not found")
    return review


def get_mine(user: User, review_id: uuid.UUID) -> dict[str, Any]:
    return present_for_customer(_own_review(user, review_id))


def update(user: User, review_id: uuid.UUID, data: dict[str, Any]) -> dict[str, Any]:
    """Customers edit; the earlier version is kept (ReviewEdit), nobody rewrites history."""
    review = _own_review(user, review_id)
    if review.status != ReviewStatus.PUBLISHED:
        raise ApiError(409, "This review was moderated and cannot be edited", code="REVIEW_LOCKED")
    until = editable_until(review)
    if until is None or timezone.now() > until:
        raise ApiError(
            409,
            f"Reviews can be edited for {EDIT_WINDOW_DAYS} days after posting",
            code="EDIT_WINDOW_CLOSED",
        )
    images = data.get("images")
    if images and review.target == T.RIDER:
        raise ApiError.bad_request("Delivery ratings don't take photos")
    before = (review.rating, review.comment, list(review.images or []))
    rating = data["rating"] if data.get("rating") is not None else review.rating
    comment = data["comment"] if data.get("comment") is not None else review.comment
    new_images = list(images) if images is not None else list(review.images or [])
    if (rating, comment, new_images) == before:
        return present_for_customer(review)

    now = timezone.now()
    with transaction.atomic():
        # Conditional on the version we read, so the saved history is exact and a concurrent
        # moderation or edit wins cleanly.
        locked = (
            Review.objects.select_for_update()
            .filter(
                pk=review.pk,
                customer=user,
                status=ReviewStatus.PUBLISHED,
                rating=review.rating,
                comment=review.comment,
            )
            .first()
        )
        if locked is None:
            raise review_changed()
        ReviewEdit.objects.create(
            review=locked, rating=before[0], comment=before[1], images=before[2], replaced_at=now
        )
        locked.rating = rating
        locked.comment = comment
        locked.images = new_images
        locked.edited_at = now
        locked.save(update_fields=["rating", "comment", "images", "edited_at", "updated_at"])
    if rating != review.rating:
        refresh_for(locked)
    return present_for_customer(Review.objects.select_related("response").get(pk=review.pk))


def remove(user: User, review_id: uuid.UUID) -> dict[str, bool]:
    """Soft delete: it leaves every listing and summary, but the moderation record survives."""
    with transaction.atomic():
        review = (
            Review.objects.select_for_update()
            .filter(pk=review_id, customer=user)
            .exclude(status=ReviewStatus.DELETED)
            .first()
        )
        if review is None:
            raise ApiError.not_found("Review not found")
        was = review.status
        review.status = ReviewStatus.DELETED
        review.deleted_at = timezone.now()
        review.save(update_fields=["status", "deleted_at", "updated_at"])
    # Hidden and removed reviews never counted, so only a published one changes the rating.
    if was == ReviewStatus.PUBLISHED:
        refresh_for(review)
    rewards.review_withdrawn(review, "review deleted")
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------
def _assert_can_report(user: User, review: Review) -> None:
    if user.role == Role.CUSTOMER:
        if review.customer_id == user.pk:
            raise ApiError.bad_request("You cannot report your own review")
        return
    if (
        user.role == Role.RESTAURANT
        and review.target != T.RIDER
        and Restaurant.objects.filter(pk=review.restaurant_id, owner=user).exists()
    ):
        return
    if (
        user.role == Role.DELIVERY
        and review.target == T.RIDER
        and review.delivery_partner_id == user.pk
    ):
        return
    raise ApiError.not_found("Review not found")


def sync_open_reports(review_id: Any) -> int:
    open_reports = ReviewReport.objects.filter(
        review_id=review_id, status=ReportStatus.OPEN
    ).count()
    Review.objects.filter(pk=review_id).update(open_reports=open_reports)
    return open_reports


def report(user: User, review_id: uuid.UUID, data: dict[str, Any]) -> dict[str, bool]:
    review = Review.objects.filter(pk=review_id, status=ReviewStatus.PUBLISHED).first()
    if review is None:
        raise ApiError.not_found("Review not found")
    _assert_can_report(user, review)
    try:
        with transaction.atomic():
            ReviewReport.objects.create(
                review=review,
                reporter=user,
                reporter_role=user.role,
                reason=data["reason"],
                note=data.get("note") or "",
            )
    except IntegrityError:
        raise ApiError(
            409, "You have already reported this review", code="ALREADY_REPORTED"
        ) from None
    if sync_open_reports(review.pk) == 1:
        notify_admins(
            Permission.REVIEWS_MODERATE,
            type="review.reported",
            title="A review was reported",
            body=f"Order {review.order_number}: {data['reason'].replace('_', ' ', 1)}",
            link="/admin/reviews",
        )
    return {"reported": True}


# ---------------------------------------------------------------------------
# Public
# ---------------------------------------------------------------------------
def _public_page(qs: QuerySet[Review], query: dict[str, Any], page: Page) -> dict[str, Any]:
    qs = qs.filter(status=ReviewStatus.PUBLISHED)
    if query.get("rating"):
        qs = qs.filter(rating=query["rating"])
    items, meta = paginate(_sorted(qs.select_related("response"), query.get("sort")), page)
    return {"items": [present_public(r) for r in items], "pagination": meta}


def public_restaurant_reviews(
    restaurant: Restaurant, query: dict[str, Any], page: Page
) -> dict[str, Any]:
    """The summary is the cached rating, which refresh_rating keeps exact."""
    reviews = Review.objects.filter(target=T.RESTAURANT, restaurant=restaurant)
    return {"summary": rating_json(restaurant), **_public_page(reviews, query, page)}


def public_food_reviews(food_id: uuid.UUID, query: dict[str, Any], page: Page) -> dict[str, Any]:
    food = FoodItem.objects.filter(pk=food_id, deleted_at__isnull=True).first()
    if food is None:
        raise ApiError.not_found("Dish not found")
    reviews = Review.objects.filter(target=T.FOOD, food_item=food)
    return {"summary": rating_json(food), **_public_page(reviews, query, page)}
