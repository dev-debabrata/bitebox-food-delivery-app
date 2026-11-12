"""Restaurants: partner onboarding, admin review, public discovery (Node: restaurant.service.js)."""

import uuid
from typing import Any

from django.db import connection, transaction
from django.db.models import Count, F, Q, QuerySet
from django.db.models.fields import TextField
from django.db.models.functions import Cast
from django.utils import timezone

from apps.accounts.models import User
from apps.menus.models import FoodItem
from apps.notifications.services import notify, notify_admins
from apps.rbac.roles import Permission
from common.api import ApiError
from common.geo import GeoPoint
from common.geo_sql import Distance, DWithin, point_sql
from common.pagination import Page, paginate
from common.slug import unique_slug

from .models import ADMIN_STATUS_TRANSITIONS, Restaurant, RestaurantStatus
from .presenters import restaurant_json

OWNER_FIELDS = (
    "name",
    "description",
    "cuisines",
    "phone",
    "email",
    "image_url",
    "is_pure_veg",
    "cost_for_two_paise",
    "min_order_paise",
    "avg_prep_time_minutes",
    "opening_time",
    "closing_time",
)
ADDRESS_FIELDS = ("line1", "line2", "area", "city", "state", "postal_code")

STATUS_NOTICE = {
    RestaurantStatus.APPROVED: (
        "Your restaurant is live",
        "Customers can now find you and place orders.",
    ),
    RestaurantStatus.REJECTED: (
        "Your application needs changes",
        "Update your details to send it for review again.",
    ),
    RestaurantStatus.SUSPENDED: (
        "Your restaurant is suspended",
        "Customers cannot order until BiteBox reinstates it.",
    ),
}


def _apply(restaurant: Restaurant, data: dict[str, Any]) -> None:
    for field in OWNER_FIELDS:
        if field in data:
            setattr(restaurant, field, data[field] if data[field] is not None else "")
    if address := data.get("address"):
        for field in ADDRESS_FIELDS:
            setattr(restaurant, field, address.get(field, "") or "")
    if location := data.get("location"):
        restaurant.location = GeoPoint(lat=location["latitude"], lng=location["longitude"])


def _review_request(r: Restaurant, title: str, body: str) -> dict[str, str]:
    return {
        "type": "restaurant.review",
        "title": f"{title}: {r.name}",
        "body": body,
        "link": f"/admin/restaurants/{r.pk}",
    }


def own_restaurant(owner: User) -> Restaurant | None:
    return Restaurant.objects.filter(owner=owner).first()


def require_own_restaurant(owner: User) -> Restaurant:
    restaurant = own_restaurant(owner)
    if restaurant is None:
        raise ApiError.not_found("Create your restaurant profile first")
    return restaurant


def create_own(owner: User, data: dict[str, Any]) -> Restaurant:
    if Restaurant.objects.filter(owner=owner).exists():
        raise ApiError.conflict("You already have a restaurant. Edit it instead.")
    restaurant = Restaurant(owner=owner, status=RestaurantStatus.PENDING)
    _apply(restaurant, data)
    restaurant.slug = unique_slug(Restaurant, data["name"])
    restaurant.save()
    notify_admins(
        Permission.RESTAURANTS_MANAGE,
        **_review_request(
            restaurant, "New restaurant application", "Review it to put it live on BiteBox."
        ),
    )
    return restaurant


def update_own(owner: User, data: dict[str, Any]) -> Restaurant:
    restaurant = require_own_restaurant(owner)
    old_name = restaurant.name
    _apply(restaurant, data)
    if data.get("name") and data["name"] != old_name:
        restaurant.slug = unique_slug(Restaurant, data["name"], restaurant.pk)
    resubmitted = restaurant.status == RestaurantStatus.REJECTED
    if resubmitted:  # editing a rejected application sends it back for review
        restaurant.status = RestaurantStatus.PENDING
        restaurant.status_reason = ""
    restaurant.save()
    if resubmitted:
        notify_admins(
            Permission.RESTAURANTS_MANAGE,
            **_review_request(
                restaurant, "Restaurant resubmitted", "The owner updated a rejected application."
            ),
        )
    return restaurant


def set_accepting_orders(owner: User, accepting: bool) -> Restaurant:
    restaurant = require_own_restaurant(owner)
    restaurant.is_accepting_orders = accepting
    restaurant.save(update_fields=["is_accepting_orders", "updated_at"])
    return restaurant


def owner_stats(restaurant: Restaurant) -> dict[str, int]:
    items = FoodItem.objects.filter(restaurant=restaurant, deleted_at__isnull=True)
    return {
        "total_items": items.count(),
        "available_items": items.filter(is_available=True).count(),
        "categories_used": items.values("category").distinct().count(),
    }


# --- admin ----------------------------------------------------------------------------------------


def _text_search(qs: QuerySet[Restaurant], search: str) -> QuerySet[Restaurant]:
    return qs.annotate(_cuisines=Cast("cuisines", TextField())).filter(
        Q(name__icontains=search) | Q(city__icontains=search) | Q(_cuisines__icontains=search)
    )


def admin_list(query: dict[str, Any], page: Page) -> dict[str, Any]:
    qs = Restaurant.objects.select_related("owner").order_by("-created_at")
    if query.get("status"):
        qs = qs.filter(status=query["status"])
    if search := (query.get("search") or "").strip():
        qs = _text_search(qs, search)
    items, meta = paginate(qs, page)
    return {"items": [restaurant_json(r, owner="admin") for r in items], "pagination": meta}


def admin_get(restaurant_id: uuid.UUID) -> Restaurant:
    restaurant = Restaurant.objects.select_related("owner").filter(pk=restaurant_id).first()
    if restaurant is None:
        raise ApiError.not_found("Restaurant not found")
    return restaurant


def admin_counts() -> dict[str, int]:
    counts = {s.value: 0 for s in RestaurantStatus}
    for row in Restaurant.objects.values("status").annotate(n=Count("id")):
        counts[row["status"]] = row["n"]
    return counts


def admin_set_status(restaurant_id: uuid.UUID, status: str, reason: str, admin: User) -> Restaurant:
    current = Restaurant.objects.filter(pk=restaurant_id).values_list("status", flat=True).first()
    if current is None:
        raise ApiError.not_found("Restaurant not found")
    if status not in ADMIN_STATUS_TRANSITIONS.get(current, frozenset()):
        raise ApiError.conflict(f"Cannot change a {current} restaurant to {status}")
    if status in (RestaurantStatus.REJECTED, RestaurantStatus.SUSPENDED) and not reason:
        raise ApiError.bad_request("A reason is required")

    with transaction.atomic():
        # Only if nobody changed it in the meantime.
        changed = Restaurant.objects.filter(pk=restaurant_id, status=current).update(
            status=status,
            status_reason=reason or "",
            reviewed_at=timezone.now(),
            reviewed_by=admin,
            updated_at=timezone.now(),
        )
        if not changed:
            raise ApiError.conflict(
                "This restaurant was updated by someone else. Refresh and try again."
            )
        restaurant = admin_get(restaurant_id)
    if notice := STATUS_NOTICE.get(RestaurantStatus(status)):
        title, body = notice
        notify(
            restaurant.owner_id,
            type=f"restaurant.{status}",
            title=title,
            body=f"{body} Reason: {reason}" if reason else body,
            link="/restaurant",
        )
    return restaurant


# --- public ---------------------------------------------------------------------------------------

TABLE = connection.ops.quote_name(Restaurant._meta.db_table)
CUISINE_MATCH_SQL = (
    f"EXISTS (SELECT 1 FROM jsonb_array_elements_text({TABLE}.cuisines) c "  # noqa: S608 (table name)
    "WHERE lower(c) = lower(%s))"
)

SORTS: dict[str, tuple[Any, ...]] = {
    "rating": (F("rating_average").desc(), F("rating_count").desc(), "id"),
    "fastest": ("avg_prep_time_minutes", "id"),
    "costLow": ("cost_for_two_paise", "id"),
    "costHigh": (F("cost_for_two_paise").desc(), "id"),
    "newest": (F("created_at").desc(), "id"),
    "distance": ("distance_m", "id"),
}


def list_public(query: dict[str, Any], page: Page) -> dict[str, Any]:
    qs = Restaurant.objects.filter(status=RestaurantStatus.APPROVED)
    if search := (query.get("search") or "").strip():
        dish_restaurants = FoodItem.objects.filter(
            name__icontains=search, deleted_at__isnull=True
        ).values("restaurant_id")
        qs = qs.annotate(_cuisines=Cast("cuisines", TextField())).filter(
            Q(name__icontains=search) | Q(_cuisines__icontains=search) | Q(id__in=dish_restaurants)
        )
    if cuisine := (query.get("cuisine") or "").strip():
        # One of the cuisines equals it, ignoring case (Node: cuisines: /^x$/i).
        qs = qs.extra(  # noqa: S610 (the value is a bound parameter)
            where=[CUISINE_MATCH_SQL], params=[cuisine]
        )
    if query.get("veg"):
        qs = qs.filter(is_pure_veg=True)
    if category := query.get("category"):
        qs = qs.filter(
            id__in=FoodItem.objects.filter(
                category_id=category, deleted_at__isnull=True, is_available=True
            ).values("restaurant_id")
        )

    geo = query.get("lat") is not None and query.get("lng") is not None
    sort = query.get("sort") or ("distance" if geo else "rating")
    if sort == "distance" and not geo:
        raise ApiError.bad_request("Sorting by distance needs lat and lng")
    if geo:
        near = point_sql(GeoPoint(lat=query["lat"], lng=query["lng"]))
        radius_m = float(query.get("radius_km") or 15) * 1000
        qs = qs.filter(DWithin(F("location"), near, radius_m)).annotate(
            distance_m=Distance(F("location"), near)
        )

    items, meta = paginate(qs.order_by(*SORTS[sort]), page)
    return {
        "items": [
            restaurant_json(
                r, owner="public", distance_m=getattr(r, "distance_m", None) if geo else None
            )
            for r in items
        ],
        "pagination": meta,
    }


def list_cuisines() -> list[str]:
    names: set[str] = set()
    for cuisines in Restaurant.objects.filter(status=RestaurantStatus.APPROVED).values_list(
        "cuisines", flat=True
    ):
        names.update(c.strip() for c in cuisines or [] if c and c.strip())
    return sorted(names, key=lambda c: (c.casefold(), c))


def get_public(slug_or_id: str) -> Restaurant:
    try:
        lookup: dict[str, Any] = {"pk": uuid.UUID(slug_or_id)}
    except ValueError:
        lookup = {"slug": slug_or_id.lower()}
    restaurant = Restaurant.objects.filter(status=RestaurantStatus.APPROVED, **lookup).first()
    if restaurant is None:
        raise ApiError.not_found("Restaurant not found")
    return restaurant
