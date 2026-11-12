"""
Reviews (Node: services/review.service.js). This phase ports what the restaurant panel uses:
its reviews grouped per order, the rating summary, and public replies. Writing, editing,
reporting and moderating reviews come with the customer and admin phases.
"""

import uuid
from typing import Any

from django.db import transaction
from django.db.models import Avg, Count, Max, Min, QuerySet, Sum

from apps.accounts.models import User
from apps.cart.pricing import js_round
from apps.delivery.models import DeliveryPartner
from apps.menus.models import FoodItem
from apps.notifications.services import notify
from apps.restaurants.models import Restaurant
from apps.restaurants.presenters import rating_json
from common.api import ApiError
from common.pagination import Page

from .models import Review, ReviewReport, ReviewResponse, ReviewStatus, ReviewTarget

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


def _order_group(order_id: Any, reviews: list[Review]) -> dict[str, Any]:
    reviews.sort(key=_by_target)
    return {
        "order": str(order_id),
        "order_number": reviews[0].order_number,
        "customer_name": reviews[0].customer_name,
        "created_at": max(r.created_at for r in reviews),
        "reviews": reviews,
    }


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
    by_order: dict[Any, list[Review]] = {oid: [] for oid in order_ids}
    for r in reviews:
        by_order[r.order_id].append(r)
    items = [
        _restaurant_order_view(_order_group(oid, rows), reported)
        for oid, rows in by_order.items()
        if rows
    ]
    return {"items": items, "pagination": meta}


def restaurant_order(owner: User, order_id: uuid.UUID) -> dict[str, Any]:
    """Every review of one order (restaurant and dishes), for the order dialog."""
    restaurant = _own_restaurant(owner)
    reviews = list(
        _restaurant_reviews(restaurant).filter(order_id=order_id).select_related("response")
    )
    if not reviews:
        raise ApiError.not_found("No reviews for this order")
    return _restaurant_order_view(_order_group(order_id, reviews), _reported_by(owner, reviews))


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
