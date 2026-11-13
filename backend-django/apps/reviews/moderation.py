"""
Admin review moderation and rating analytics (Node: services/review-moderation.service.js).

Admins change a review's visibility, never its words. Every change is conditional on the status
read ("still in status X") and is logged (ReviewModeration) with who, when and why.
"""

import uuid
from datetime import timedelta
from typing import Any
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import transaction
from django.db.models import Count, Prefetch, Q, QuerySet, Sum
from django.db.models.functions import TruncDate
from django.utils import timezone

from apps.accounts.models import User
from apps.cart.pricing import js_round
from apps.delivery.models import DeliveryPartner
from apps.finance.reports import day_keys
from apps.notifications.services import notify
from apps.restaurants.models import Restaurant, RestaurantStatus
from common.api import ApiError
from common.pagination import Page

from . import rewards
from .models import (
    MIN_REVIEWS_TO_RANK,
    ModerationAction,
    ReportStatus,
    Review,
    ReviewEdit,
    ReviewModeration,
    ReviewReport,
    ReviewStatus,
    ReviewTarget,
)
from .services import (
    group_reviews,
    order_group,
    order_page,
    refresh_for,
    response_view,
    review_changed,
    summarize,
)

S = ReviewStatus
A = ModerationAction

# action → (statuses it may start from, the status it leads to)
MODERATION_MOVES: dict[str, tuple[tuple[str, ...], str]] = {
    A.HIDE: ((S.PUBLISHED,), S.HIDDEN),
    A.REMOVE: ((S.PUBLISHED, S.HIDDEN), S.REMOVED),
    A.RESTORE: ((S.HIDDEN, S.REMOVED), S.PUBLISHED),
}

# "Review hidden", "A removed review cannot be hidden"
PAST: dict[str, str] = {A.HIDE: "hidden", A.REMOVE: "removed", A.RESTORE: "restored"}

MODERATION_MESSAGE: dict[str, str] = {
    A.HIDE: "Your review is hidden while we look into it",
    A.REMOVE: "Your review was removed",
    A.RESTORE: "Your review is visible again",
}


def _ref(obj: Any, **extra: Any) -> dict[str, Any] | None:
    return {"id": str(obj.pk), "name": obj.name, **extra} if obj is not None else None


def present_for_admin(review: Review) -> dict[str, Any]:
    """Every stored field (Node: review.toJSON()), with the restaurant and rider named."""
    data: dict[str, Any] = {
        "id": str(review.pk),
        "target": review.target,
        "customer": str(review.customer_id),
        "customer_name": review.customer_name,
        "order": str(review.order_id),
        "order_number": review.order_number,
        "restaurant": _ref(review.restaurant, slug=review.restaurant.slug),
        "food_item": str(review.food_item_id) if review.food_item_id else None,
    }
    if review.food_name:
        data["food_name"] = review.food_name
    data.update(
        {
            "delivery_partner": _ref(review.delivery_partner),
            "rating": review.rating,
            "comment": review.comment,
            "images": list(review.images or []),
            "status": review.status,
            "edited_at": review.edited_at,
            "deleted_at": review.deleted_at,
        }
    )
    response = response_view(review)
    if response is not None:
        data["response"] = response
    data["open_reports"] = review.open_reports
    if review.moderation_action:
        data["moderation"] = {
            "action": review.moderation_action,
            "reason": review.moderation_reason,
            "at": review.moderated_at,
        }
    data["created_at"] = review.created_at
    data["updated_at"] = review.updated_at
    return data


def _admin_filter(query: dict[str, Any]) -> QuerySet[Review]:
    qs = Review.objects.all()
    qs = qs.filter(status=query["status"]) if query.get("status") else qs.exclude(status=S.DELETED)
    if query.get("target"):
        qs = qs.filter(target=query["target"])
    if query.get("rating"):
        qs = qs.filter(rating=query["rating"])
    if query.get("restaurant_id"):
        qs = qs.filter(restaurant_id=query["restaurant_id"])
    if query.get("reported") is True:
        qs = qs.filter(open_reports__gt=0)
    search = (query.get("search") or "").strip()
    if search:
        qs = qs.filter(
            Q(order_number__icontains=search)
            | Q(customer_name__icontains=search)
            | Q(food_name__icontains=search)
            | Q(comment__icontains=search)
        )
    return qs


def _admin_order_view(group: dict[str, Any], reviews: list[Any]) -> dict[str, Any]:
    """Order row fields every admin view shares; `reviews` is what the row carries."""
    loaded: list[Review] = group.pop("reviews")
    return {
        **group,
        "restaurant": _ref(loaded[0].restaurant),
        "open_reports": sum(r.open_reports for r in loaded),
        "reviews": reviews,
    }


def admin_orders(query: dict[str, Any], page: Page) -> dict[str, Any]:
    """One row per order with every review of it (deleted ones only when asked for)."""
    sort = "reported" if query.get("reported") is True else "newest"
    order_ids, meta = order_page(_admin_filter(query), sort, page)
    # Orders with an open report on a visible review: the "Reported" tab badge.
    reported = (
        Review.objects.filter(open_reports__gt=0, status__in=[S.PUBLISHED, S.HIDDEN])
        .values("order_id")
        .distinct()
        .count()
    )
    reviews = Review.objects.filter(order_id__in=order_ids).select_related(
        "restaurant", "delivery_partner", "response"
    )
    if query.get("status") != S.DELETED:
        reviews = reviews.exclude(status=S.DELETED)
    items = [
        _admin_order_view(g, [present_for_admin(r) for r in g["reviews"]])
        for g in group_reviews(order_ids, list(reviews))
    ]
    return {"items": items, "pagination": meta, "counts": {"reported": reported}}


def _load_detailed(**filters: Any) -> list[Review]:
    return list(
        Review.objects.filter(**filters)
        .select_related("restaurant", "delivery_partner", "customer", "response")
        .prefetch_related(
            Prefetch("edits", queryset=ReviewEdit.objects.order_by("replaced_at", "id")),
            Prefetch(
                "moderation_log",
                queryset=ReviewModeration.objects.select_related("by").order_by("created_at", "id"),
            ),
        )
    )


def _detailed(reviews: list[Review]) -> list[dict[str, Any]]:
    """Full records: earlier versions, reports and the moderation log."""
    reports = list(
        ReviewReport.objects.filter(review__in=[r.pk for r in reviews])
        .select_related("reporter", "resolved_by")
        .order_by("-created_at", "-id")
    )
    out = []
    for review in reviews:
        data = present_for_admin(review)
        data["customer"] = _ref(review.customer, email=review.customer.email)
        data["edits"] = [
            {
                "rating": e.rating,
                "comment": e.comment,
                "images": list(e.images or []),
                "replaced_at": e.replaced_at,
            }
            for e in review.edits.all()
        ]
        data["moderation_log"] = [
            {
                "action": m.action,
                "reason": m.reason,
                "from_status": m.from_status or None,
                "to_status": m.to_status or None,
                "at": m.created_at,
                "by": _ref(m.by),
            }
            for m in review.moderation_log.all()
        ]
        data["reports"] = [
            {
                "id": str(r.pk),
                "reason": r.reason,
                "note": r.note or None,
                "status": r.status,
                "reporter_role": r.reporter_role,
                "reporter_name": r.reporter.name if r.reporter else None,
                "created_at": r.created_at,
                "resolved_at": r.resolved_at,
                "resolved_by": r.resolved_by.name if r.resolved_by else None,
            }
            for r in reports
            if r.review_id == review.pk
        ]
        out.append(data)
    return out


def admin_order(order_id: uuid.UUID) -> dict[str, Any]:
    """Everything about one order's reviews, each with earlier versions, reports and its log."""
    reviews = _load_detailed(order_id=order_id)
    if not reviews:
        raise ApiError.not_found("No reviews for this order")
    group = order_group(order_id, reviews)
    sorted_reviews: list[Review] = list(group["reviews"])
    view = _admin_order_view(group, _detailed(sorted_reviews))
    view["customer_name"] = sorted_reviews[0].customer.name or view["customer_name"]
    return view


def admin_get(review_id: uuid.UUID) -> dict[str, Any]:
    reviews = _load_detailed(pk=review_id)
    if not reviews:
        raise ApiError.not_found("Review not found")
    return _detailed(reviews)[0]


def _close_reports(review_id: Any, admin: User, status: str) -> int:
    """Closes every open report of a review; the caller sets `open_reports` on the review."""
    now = timezone.now()
    return ReviewReport.objects.filter(review_id=review_id, status=ReportStatus.OPEN).update(
        status=status, resolved_at=now, resolved_by=admin, updated_at=now
    )


def moderate(admin: User, review_id: uuid.UUID, action: str, reason: str) -> dict[str, Any]:
    allowed_from, to = MODERATION_MOVES[action]
    review = Review.objects.filter(pk=review_id).first()
    if review is None:
        raise ApiError.not_found("Review not found")
    if review.status == to:
        return admin_get(review_id)  # repeating the same move is a no-op
    if review.status not in allowed_from:
        raise ApiError(
            409, f"A {review.status} review cannot be {PAST[action]}", code="INVALID_MODERATION"
        )

    hiding = to != S.PUBLISHED
    now = timezone.now()
    with transaction.atomic():
        updated = (
            Review.objects.select_for_update().filter(pk=review.pk, status=review.status).first()
        )
        if updated is None:
            raise review_changed()
        updated.status = to
        updated.moderation_action = action
        updated.moderation_reason = reason
        updated.moderated_at = now
        fields = ["status", "moderation_action", "moderation_reason", "moderated_at", "updated_at"]
        if hiding:
            updated.open_reports = 0
            fields.append("open_reports")
        updated.save(update_fields=fields)
        ReviewModeration.objects.create(
            review=updated,
            action=action,
            reason=reason,
            from_status=review.status,
            to_status=to,
            by=admin,
        )
        if hiding:
            _close_reports(updated.pk, admin, ReportStatus.ACTIONED)

    if to == S.REMOVED:
        rewards.review_withdrawn(updated, "review removed by moderation")
    # hidden -> removed changes no rating: neither counted.
    if review.status == S.PUBLISHED or to == S.PUBLISHED:
        refresh_for(updated)
    notify(
        updated.customer_id,
        type="review.moderated",
        title=MODERATION_MESSAGE[action],
        body=(
            f"Order {updated.order_number}" if action == A.RESTORE else f"Reason: {reason}"[:300]
        ),
        link=f"/orders/{updated.order_id}",
    )
    return admin_get(review_id)


def dismiss_reports(admin: User, review_id: uuid.UUID, reason: str) -> dict[str, Any]:
    """ "Nothing wrong here": closes the open reports and logs it; the review stays as it is."""
    review = Review.objects.filter(pk=review_id).exclude(status=S.DELETED).first()
    if review is None:
        raise ApiError.not_found("Review not found")
    with transaction.atomic():
        if not _close_reports(review.pk, admin, ReportStatus.DISMISSED):
            raise ApiError(409, "This review has no open reports", code="NO_OPEN_REPORTS")
        Review.objects.filter(pk=review.pk).update(open_reports=0, updated_at=timezone.now())
        ReviewModeration.objects.create(
            review=review,
            action=A.DISMISS_REPORTS,
            reason=reason,
            from_status=review.status,
            to_status=review.status,
            by=admin,
        )
    return admin_get(review_id)


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------
def _ranked_restaurants(descending: bool) -> list[dict[str, Any]]:
    rows = Restaurant.objects.filter(
        status=RestaurantStatus.APPROVED, rating_count__gte=MIN_REVIEWS_TO_RANK
    ).order_by("-rating_average" if descending else "rating_average", "-rating_count")[:5]
    return [
        {
            "id": str(r.pk),
            "name": r.name,
            "average": float(r.rating_average),
            "count": r.rating_count,
        }
        for r in rows
    ]


def _ranked_riders(descending: bool) -> list[dict[str, Any]]:
    rows = (
        DeliveryPartner.objects.filter(rating_count__gte=MIN_REVIEWS_TO_RANK)
        .select_related("user")
        .order_by("-rating_average" if descending else "rating_average", "-rating_count")[:5]
    )
    return [
        {
            "id": str(p.user_id),
            "name": p.user.name,
            "average": float(p.rating_average),
            "count": p.rating_count,
        }
        for p in rows
    ]


def analytics(days: int) -> dict[str, Any]:
    now = timezone.now()
    since = now - timedelta(days=days)
    tz = ZoneInfo(settings.REPORT_TIMEZONE)

    # All-time published reviews: what the public averages are built from.
    by_target = (
        Review.objects.filter(status=S.PUBLISHED)
        .values("target", "rating")
        .annotate(n=Count("pk"))
        .order_by()
    )
    targets = {
        t: summarize({r["rating"]: r["n"] for r in by_target if r["target"] == t})
        for t in ReviewTarget.values
    }
    statuses = Review.objects.values("status").annotate(n=Count("pk")).order_by()
    daily_rows = (
        Review.objects.filter(created_at__gte=since)
        .exclude(status=S.DELETED)
        .annotate(day=TruncDate("created_at", tzinfo=tz))
        .values("day")
        .annotate(reviews=Count("pk"), rating_sum=Sum("rating"))
        .order_by()
    )
    by_day = {row["day"].isoformat(): row for row in daily_rows}
    daily = []
    for key in day_keys(days, now):
        row = by_day.get(key) or {}
        n = row.get("reviews", 0)
        daily.append(
            {
                "date": key,
                "reviews": n,
                "average_rating": js_round(row["rating_sum"] / n * 100) / 100 if n else 0,
            }
        )
    reasons = (
        ReviewReport.objects.filter(created_at__gte=since)
        .values("reason")
        .annotate(n=Count("pk"))
        .order_by("-n")
    )
    moderation = (
        ReviewModeration.objects.filter(created_at__gte=since)
        .values("action")
        .annotate(n=Count("pk"))
        .order_by()
    )
    return {
        "days": days,
        "targets": targets,
        "status_counts": {r["status"]: r["n"] for r in statuses},
        "new_reviews": sum(d["reviews"] for d in daily),
        "open_reports": ReviewReport.objects.filter(status=ReportStatus.OPEN).count(),
        "report_reasons": [{"reason": r["reason"], "count": r["n"]} for r in reasons],
        # Keyed by action ("dismiss_reports"): JSON_CAMEL_CASE ignore_fields keeps the keys.
        "moderation_actions": {r["action"]: r["n"] for r in moderation},
        "daily": daily,
        "restaurants": {"top": _ranked_restaurants(True), "bottom": _ranked_restaurants(False)},
        "riders": {"top": _ranked_riders(True), "bottom": _ranked_riders(False)},
        "min_reviews_to_rank": MIN_REVIEWS_TO_RANK,
    }
