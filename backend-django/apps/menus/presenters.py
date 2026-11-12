"""Category and dish JSON in the Node API's shape."""

from typing import Any

from apps.restaurants.presenters import rating_json

from .models import FoodCategory, FoodItem


def category_json(c: FoodCategory, *, item_count: int | None = None) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": str(c.pk),
        "name": c.name,
        "slug": c.slug,
        "icon": c.icon,
        "sort_order": c.sort_order,
        "is_active": c.is_active,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
    }
    if c.description:
        data["description"] = c.description
    if c.image_url:
        data["image_url"] = c.image_url
    if item_count is not None:
        data["item_count"] = item_count
    return data


def category_ref(c: FoodCategory | None, *, with_sort: bool = False) -> dict[str, Any] | None:
    """The populated `category` on a dish: {id, name, slug, icon}."""
    if c is None:
        return None
    ref: dict[str, Any] = {"id": str(c.pk), "name": c.name, "slug": c.slug, "icon": c.icon}
    if with_sort:
        ref["sort_order"] = c.sort_order
    return ref


def food_json(item: FoodItem, *, restaurant: Any = "id", with_sort: bool = False) -> dict[str, Any]:
    """restaurant="id" (just the id) or a dict to embed (admin and dish details)."""
    data: dict[str, Any] = {
        "id": str(item.pk),
        "restaurant": str(item.restaurant_id) if restaurant == "id" else restaurant,
        "category": category_ref(item.category, with_sort=with_sort),
        "name": item.name,
        "price_paise": item.price_paise,
        "is_veg": item.is_veg,
        "is_available": item.is_available,
        "tags": list(item.tags or []),
        "rating": rating_json(item),
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }
    if item.description:
        data["description"] = item.description
    if item.image_url:
        data["image_url"] = item.image_url
    if item.prep_time_minutes is not None:
        data["prep_time_minutes"] = item.prep_time_minutes
    return data
