"""Categories and dishes (Node: category.service.js, food.service.js)."""

import uuid
from typing import Any

from django.db.models import Count, F, QuerySet
from django.utils import timezone

from apps.restaurants.models import Restaurant, RestaurantStatus
from apps.restaurants.presenters import is_open_now, rating_json
from common.api import ApiError
from common.pagination import Page, paginate
from common.slug import unique_slug

from .models import FoodCategory, FoodItem
from .presenters import category_json, category_ref, food_json

# --- categories -----------------------------------------------------------------------------------

CATEGORY_FIELDS = ("name", "description", "icon", "image_url", "sort_order", "is_active")
CATEGORY_ORDER = ("sort_order", "name")


def _category_name_taken(name: str, exclude: uuid.UUID | None = None) -> bool:
    qs = FoodCategory.objects.filter(name__iexact=name.strip())
    return (qs.exclude(pk=exclude) if exclude else qs).exists()


def list_active_categories() -> list[dict[str, Any]]:
    return [
        category_json(c)
        for c in FoodCategory.objects.filter(is_active=True).order_by(*CATEGORY_ORDER)
    ]


def admin_list_categories() -> list[dict[str, Any]]:
    counts = dict(
        FoodItem.objects.filter(deleted_at__isnull=True)
        .values("category_id")
        .annotate(n=Count("id"))
        .values_list("category_id", "n")
    )
    return [
        category_json(c, item_count=counts.get(c.pk, 0))
        for c in FoodCategory.objects.order_by(*CATEGORY_ORDER)
    ]


def create_category(data: dict[str, Any]) -> FoodCategory:
    if _category_name_taken(data["name"]):
        raise ApiError.conflict("A category with this name already exists")
    category = FoodCategory(slug=unique_slug(FoodCategory, data["name"]))
    for field in CATEGORY_FIELDS:
        if field in data and data[field] is not None:
            setattr(category, field, data[field])
    category.save()
    return category


def update_category(category_id: uuid.UUID, data: dict[str, Any]) -> FoodCategory:
    category = FoodCategory.objects.filter(pk=category_id).first()
    if category is None:
        raise ApiError.not_found("Category not found")
    if data.get("name") and data["name"] != category.name:
        if _category_name_taken(data["name"], exclude=category.pk):
            raise ApiError.conflict("A category with this name already exists")
        category.slug = unique_slug(FoodCategory, data["name"], category.pk)
    for field in CATEGORY_FIELDS:
        if field in data and data[field] is not None:
            setattr(category, field, data[field])
    category.save()
    return category


def delete_category(category_id: uuid.UUID) -> None:
    if FoodItem.objects.filter(category_id=category_id, deleted_at__isnull=True).exists():
        raise ApiError.conflict("This category is used by menu items. Deactivate it instead.")
    # Soft-deleted dishes still point here (old orders link to them); keep the row in that case.
    deleted, _ = (
        FoodCategory.objects.filter(pk=category_id).exclude(food_items__isnull=False).delete()
    )
    if not deleted:
        if FoodCategory.objects.filter(pk=category_id).exists():
            FoodCategory.objects.filter(pk=category_id).update(
                is_active=False, updated_at=timezone.now()
            )
            return
        raise ApiError.not_found("Category not found")


# --- dishes ---------------------------------------------------------------------------------------

FOOD_FIELDS = (
    "name",
    "description",
    "category_id",
    "price_paise",
    "is_veg",
    "is_available",
    "image_url",
    "prep_time_minutes",
    "tags",
)


def _require_active_category(category_id: uuid.UUID) -> None:
    if not FoodCategory.objects.filter(pk=category_id, is_active=True).exists():
        raise ApiError(
            422,
            "Validation failed",
            code="VALIDATION_ERROR",
            details=[{"field": "category", "message": "Choose an active category"}],
        )


def _require_unique_name(
    restaurant: Restaurant, name: str, exclude: uuid.UUID | None = None
) -> None:
    qs = FoodItem.objects.filter(
        restaurant=restaurant, deleted_at__isnull=True, name__iexact=name.strip()
    )
    if (qs.exclude(pk=exclude) if exclude else qs).exists():
        raise ApiError.conflict("Your menu already has an item with this name")


def _apply_food(item: FoodItem, data: dict[str, Any]) -> None:
    if "category" in data:
        data = {**data, "category_id": data["category"]}
    for field in FOOD_FIELDS:
        if field in data:
            value = data[field]
            if field in ("description", "image_url") and value is None:
                value = ""
            setattr(item, field, value)


def _filtered(qs: QuerySet[FoodItem], query: dict[str, Any]) -> QuerySet[FoodItem]:
    qs = qs.filter(deleted_at__isnull=True)
    if search := (query.get("search") or "").strip():
        qs = qs.filter(name__icontains=search)
    if query.get("category"):
        qs = qs.filter(category_id=query["category"])
    if query.get("available") is not None:
        qs = qs.filter(is_available=query["available"])
    if query.get("veg"):
        qs = qs.filter(is_veg=True)
    return qs


def owner_list(restaurant: Restaurant, query: dict[str, Any], page: Page) -> dict[str, Any]:
    qs = _filtered(FoodItem.objects.select_related("category").filter(restaurant=restaurant), query)
    items, meta = paginate(qs.order_by("category__name", "name"), page)
    return {"items": [food_json(i) for i in items], "pagination": meta}


def _owner_item(restaurant: Restaurant, item_id: uuid.UUID) -> FoodItem:
    item = (
        FoodItem.objects.select_related("category")
        .filter(pk=item_id, restaurant=restaurant, deleted_at__isnull=True)
        .first()
    )
    if item is None:
        raise ApiError.not_found("Menu item not found")
    return item


def owner_create(restaurant: Restaurant, data: dict[str, Any]) -> FoodItem:
    _require_active_category(data["category"])
    _require_unique_name(restaurant, data["name"])
    item = FoodItem(restaurant=restaurant)
    _apply_food(item, data)
    item.save()
    return FoodItem.objects.select_related("category").get(pk=item.pk)


def owner_update(restaurant: Restaurant, item_id: uuid.UUID, data: dict[str, Any]) -> FoodItem:
    item = _owner_item(restaurant, item_id)
    if data.get("category") and data["category"] != item.category_id:
        _require_active_category(data["category"])
    if data.get("name"):
        _require_unique_name(restaurant, data["name"], exclude=item.pk)
    _apply_food(item, data)
    item.save()
    return FoodItem.objects.select_related("category").get(pk=item.pk)


def owner_set_availability(restaurant: Restaurant, item_id: uuid.UUID, available: bool) -> FoodItem:
    item = _owner_item(restaurant, item_id)
    item.is_available = available
    item.save(update_fields=["is_available", "updated_at"])
    return item


def owner_delete(restaurant: Restaurant, item_id: uuid.UUID) -> None:
    """Soft delete: old orders and reviews keep pointing at the dish."""
    changed = FoodItem.objects.filter(
        pk=item_id, restaurant=restaurant, deleted_at__isnull=True
    ).update(deleted_at=timezone.now(), is_available=False, updated_at=timezone.now())
    if not changed:
        raise ApiError.not_found("Menu item not found")


def _admin_restaurant_ref(r: Restaurant) -> dict[str, Any]:
    return {"id": str(r.pk), "name": r.name, "slug": r.slug, "status": r.status}


def admin_list(query: dict[str, Any], page: Page) -> dict[str, Any]:
    qs = FoodItem.objects.select_related("category", "restaurant")
    if query.get("restaurant"):
        qs = qs.filter(restaurant_id=query["restaurant"])
    items, meta = paginate(_filtered(qs, query).order_by("-created_at"), page)
    return {
        "items": [food_json(i, restaurant=_admin_restaurant_ref(i.restaurant)) for i in items],
        "pagination": meta,
    }


def admin_set_availability(item_id: uuid.UUID, available: bool) -> dict[str, Any]:
    item = (
        FoodItem.objects.select_related("category", "restaurant")
        .filter(pk=item_id, deleted_at__isnull=True)
        .first()
    )
    if item is None:
        raise ApiError.not_found("Menu item not found")
    item.is_available = available
    item.save(update_fields=["is_available", "updated_at"])
    return food_json(item, restaurant=_admin_restaurant_ref(item.restaurant))


def admin_delete(item_id: uuid.UUID) -> None:
    changed = FoodItem.objects.filter(pk=item_id, deleted_at__isnull=True).update(
        deleted_at=timezone.now(), is_available=False, updated_at=timezone.now()
    )
    if not changed:
        raise ApiError.not_found("Menu item not found")


def public_menu(restaurant: Restaurant) -> list[dict[str, Any]]:
    """Every dish (unavailable ones flagged) grouped by category, in category order."""
    items = (
        FoodItem.objects.select_related("category")
        .filter(restaurant=restaurant, deleted_at__isnull=True)
        .order_by("name")
    )
    groups: dict[str, dict[str, Any]] = {}
    for item in items:
        c = item.category
        key = str(c.pk) if c else "other"
        group = groups.setdefault(
            key,
            {
                "category": category_ref(c),
                "sort": (c.sort_order if c else 9999, c.name if c else ""),
                "items": [],
            },
        )
        group["items"].append(food_json(item, with_sort=True))
    ordered = sorted(groups.values(), key=lambda g: g["sort"])
    return [{"category": g["category"], "items": g["items"]} for g in ordered]


def _restaurant_summary(r: Restaurant) -> dict[str, Any]:
    data = {
        "id": str(r.pk),
        "name": r.name,
        "slug": r.slug,
        "cuisines": list(r.cuisines or []),
        "rating": rating_json(r),
        "city": r.city,
        "avg_prep_time_minutes": r.avg_prep_time_minutes,
    }
    if r.image_url:
        data["image_url"] = r.image_url
    return data


def public_search(query: dict[str, Any], page: Page) -> dict[str, Any]:
    """Available dishes from approved restaurants, best-rated restaurants first."""
    qs = FoodItem.objects.select_related("category", "restaurant").filter(
        deleted_at__isnull=True, is_available=True, restaurant__status=RestaurantStatus.APPROVED
    )
    if search := (query.get("search") or "").strip():
        qs = qs.filter(name__icontains=search)
    if query.get("category"):
        qs = qs.filter(category_id=query["category"])
    if query.get("veg"):
        qs = qs.filter(is_veg=True)
    qs = qs.order_by(F("restaurant__rating_average").desc(), "name", "id")
    items, meta = paginate(qs, page)
    return {
        "items": [food_json(i, restaurant=_restaurant_summary(i.restaurant)) for i in items],
        "pagination": meta,
    }


def public_get(item_id: uuid.UUID) -> dict[str, Any]:
    item = (
        FoodItem.objects.select_related("category", "restaurant")
        .filter(pk=item_id, deleted_at__isnull=True, restaurant__status=RestaurantStatus.APPROVED)
        .first()
    )
    if item is None:
        raise ApiError.not_found("Dish not found")
    r = item.restaurant
    restaurant = {
        "id": str(r.pk),
        "name": r.name,
        "slug": r.slug,
        "cuisines": list(r.cuisines or []),
        "rating": rating_json(r),
        "is_accepting_orders": r.is_accepting_orders,
        "opening_time": r.opening_time,
        "closing_time": r.closing_time,
        "timezone": r.timezone,
        "is_open_now": is_open_now(r),
    }
    if r.image_url:
        restaurant["image_url"] = r.image_url
    return food_json(item, restaurant=restaurant)
