"""Small builders for tests (fictional data only). Each returns a saved row; override any field."""

import itertools
from datetime import timedelta
from typing import Any

from django.utils import timezone

from apps.accounts.models import User
from apps.menus.models import FoodCategory, FoodItem
from apps.orders.models import Order
from apps.rbac.roles import Role
from apps.restaurants.models import Restaurant
from common.geo import GeoPoint

_n = itertools.count(1)
PASSWORD = "Test-pass-123"


def user(role: Role = Role.CUSTOMER, **fields: Any) -> User:
    n = next(_n)
    return User.objects.create_user(
        fields.pop("email", f"user{n}@bitebox.test"),
        fields.pop("password", PASSWORD),
        fields.pop("name", f"Test User {n}"),
        role=role,
        **fields,
    )


def restaurant(**fields: Any) -> Restaurant:
    n = next(_n)
    defaults: dict[str, Any] = {
        "owner": fields.pop("owner", None) or user(Role.RESTAURANT),
        "name": f"Test Kitchen {n}",
        "slug": f"test-kitchen-{n}",
        "cuisines": ["North Indian"],
        "phone": "9000000099",
        "line1": "1 Test Street",
        "city": "Bengaluru",
        "state": "Karnataka",
        "postal_code": "560001",
        "location": GeoPoint(lat=12.97, lng=77.59),
        "cost_for_two_paise": 40000,
        "opening_time": "09:00",
        "closing_time": "23:00",
        "status": "approved",
    }
    return Restaurant.objects.create(**{**defaults, **fields})


def category(**fields: Any) -> FoodCategory:
    n = next(_n)
    return FoodCategory.objects.create(
        **{"name": f"Category {n}", "slug": f"category-{n}", **fields}
    )


def food(**fields: Any) -> FoodItem:
    n = next(_n)
    defaults: dict[str, Any] = {
        "restaurant": fields.pop("restaurant", None) or restaurant(),
        "category": fields.pop("category", None) or category(),
        "name": f"Dish {n}",
        "price_paise": 25000,
        "is_veg": True,
    }
    return FoodItem.objects.create(**{**defaults, **fields})


def order(**fields: Any) -> Order:
    """A COD order for one dish (₹250) whose totals add up."""
    n = next(_n)
    kitchen = fields.pop("restaurant", None) or restaurant()
    subtotal, delivery, platform, tax = 25000, 2500, 500, 1250
    defaults: dict[str, Any] = {
        "order_number": f"BB-T-{n:06d}",
        "customer": fields.pop("customer", None) or user(),
        "restaurant": kitchen,
        "restaurant_snapshot": {
            "name": kitchen.name,
            "slug": kitchen.slug,
            "location": kitchen.location.as_dict(),
        },
        "delivery_address": {
            "recipientName": "Asha",
            "phone": "9000000002",
            "line1": "4B",
            "city": "Bengaluru",
        },
        "delivery_location": GeoPoint(lat=12.93, lng=77.62),
        "subtotal_paise": subtotal,
        "delivery_fee_paise": delivery,
        "platform_fee_paise": platform,
        "tax_paise": tax,
        "total_paise": subtotal + delivery + platform + tax,
        "distance_m": 4200,
        "payment_method": "cod",
        "submitted_at": timezone.now() - timedelta(minutes=1),
    }
    return Order.objects.create(**{**defaults, **fields})
