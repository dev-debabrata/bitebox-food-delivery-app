"""
Development data, a port of backend/scripts/seed.js: the same fictional accounts, restaurant,
dishes, coupons, address and rider. Idempotent: rows are created only when missing (Node
`$setOnInsert`), so running it again never overwrites edits.
"""

from dataclasses import dataclass
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.coupons.models import Coupon
from apps.customers.models import Address
from apps.delivery.models import DeliveryPartner, RiderVehicle
from apps.menus.models import FoodCategory, FoodItem
from apps.rbac.roles import Role
from apps.restaurants.models import Restaurant, RestaurantStatus
from common.geo import GeoPoint

SEED_USERS = [
    ("BiteBox Admin", "admin@bitebox.test", "9000000001", Role.ADMIN),
    ("Asha Customer", "customer@bitebox.test", "9000000002", Role.CUSTOMER),
    ("Spice Route Owner", "restaurant@bitebox.test", "9000000003", Role.RESTAURANT),
    ("Ravi Rider", "rider@bitebox.test", "9000000004", Role.DELIVERY),
    ("Omar Operations", "operations@bitebox.test", "9000000005", Role.OPERATIONS_ADMIN),
    ("Farah Finance", "finance@bitebox.test", "9000000006", Role.FINANCE_ADMIN),
    ("Sana Support", "support@bitebox.test", "9000000007", Role.SUPPORT_ADMIN),
]

SEED_CATEGORIES = [
    ("Biryani", "biryani", "rice_bowl", 10),
    ("North Indian", "north-indian", "soup_kitchen", 20),
    ("South Indian", "south-indian", "breakfast_dining", 30),
    ("Chinese", "chinese", "ramen_dining", 40),
    ("Pizza", "pizza", "local_pizza", 50),
    ("Burgers", "burgers", "lunch_dining", 60),
    ("Desserts", "desserts", "icecream", 70),
    ("Beverages", "beverages", "local_cafe", 80),
]

SEED_RESTAURANT = {
    "name": "Spice Route Kitchen",
    "slug": "spice-route-kitchen",
    "description": (
        "Slow-cooked biryanis, smoky tandoor dishes and comforting South Indian classics."
    ),
    "cuisines": ["Biryani", "North Indian", "South Indian"],
    "phone": "9000000003",
    "email": "hello@spiceroute.test",
    "line1": "12, 100 Feet Road",
    "area": "Indiranagar",
    "city": "Bengaluru",
    "state": "Karnataka",
    "postal_code": "560038",
    "location": GeoPoint(lat=12.9719, lng=77.6412),
    "is_pure_veg": False,
    "cost_for_two_paise": 50000,
    "min_order_paise": 15000,
    "avg_prep_time_minutes": 25,
    "opening_time": "10:00",
    "closing_time": "23:30",
    "is_accepting_orders": True,
    "status": RestaurantStatus.APPROVED,
}

SEED_FOODS = [
    (
        "Hyderabadi Chicken Biryani",
        "biryani",
        32900,
        False,
        "Long-grain basmati layered with spiced chicken, cooked dum style.",
    ),
    (
        "Paneer Tikka Biryani",
        "biryani",
        28900,
        True,
        "Smoky paneer tikka folded into saffron rice.",
    ),
    (
        "Butter Chicken",
        "north-indian",
        34900,
        False,
        "Tandoori chicken in a silky tomato and butter gravy.",
    ),
    ("Dal Makhani", "north-indian", 24900, True, "Black lentils simmered overnight with cream."),
    ("Garlic Naan", "north-indian", 6900, True, "Tandoor-baked flatbread with garlic butter."),
    (
        "Masala Dosa",
        "south-indian",
        14900,
        True,
        "Crisp rice crepe with spiced potato, sambar and chutneys.",
    ),
    ("Gulab Jamun (2 pcs)", "desserts", 9900, True, "Warm milk dumplings in cardamom syrup."),
    ("Mango Lassi", "beverages", 11900, True, "Thick yoghurt smoothie with Alphonso mango."),
]

SEED_COUPONS = [
    {
        "code": "WELCOME50",
        "description": "50% off up to ₹100 on orders above ₹199",
        "discount_type": "percent",
        "discount_value": 50,
        "max_discount_paise": 10000,
        "min_order_paise": 19900,
        "per_user_limit": 1,
    },
    {
        "code": "FLAT75",
        "description": "₹75 off on orders above ₹399",
        "discount_type": "flat",
        "discount_value": 7500,
        "min_order_paise": 39900,
        "per_user_limit": 3,
    },
]


@dataclass
class SeedReport:
    users_created: list[str]
    passwords_reset: int
    categories_created: int
    restaurant_created: bool
    food_items_created: int
    coupons_created: int
    customer_address_created: bool
    rider_profile_created: bool


def valid_seed_password(password: str | None) -> bool:
    """Same rule as the Node seed: 8+ characters with a letter and a number."""
    return bool(
        password
        and len(password) >= 8
        and any(c.isalpha() for c in password)
        and any(c.isdigit() for c in password)
    )


@transaction.atomic
def seed(password: str, *, reset_passwords: bool = False) -> SeedReport:
    users_created: list[str] = []
    passwords_reset = 0
    for name, email, phone, role in SEED_USERS:
        user = User.objects.filter(email=email).first()
        if user is None:
            User.objects.create_user(email, password, name, phone=phone, role=role)
            users_created.append(email)
        elif reset_passwords:
            user.set_password(password)
            user.token_version += 1  # signs out existing sessions, like Node's tokenVersion bump
            user.save(update_fields=["password", "token_version", "updated_at"])
            passwords_reset += 1

    categories: dict[str, FoodCategory] = {}
    categories_created = 0
    for name, slug, icon, sort_order in SEED_CATEGORIES:
        category, created = FoodCategory.objects.get_or_create(
            slug=slug,
            defaults={"name": name, "icon": icon, "sort_order": sort_order, "is_active": True},
        )
        categories[slug] = category
        categories_created += created

    owner = User.objects.get(email="restaurant@bitebox.test")
    restaurant, restaurant_created = Restaurant.objects.get_or_create(
        owner=owner, defaults={**SEED_RESTAURANT, "reviewed_at": timezone.now()}
    )

    food_items_created = 0
    for name, slug, price, is_veg, description in SEED_FOODS:
        _, created = FoodItem.objects.get_or_create(
            restaurant=restaurant,
            name=name,
            deleted_at=None,
            defaults={
                "category": categories[slug],
                "price_paise": price,
                "is_veg": is_veg,
                "description": description,
                "is_available": True,
            },
        )
        food_items_created += created

    now = timezone.now()
    coupons_created = 0
    for coupon in SEED_COUPONS:
        _, created = Coupon.objects.get_or_create(
            code=coupon["code"],
            defaults={
                **coupon,
                "valid_from": now,
                "valid_until": now + timedelta(days=365),
                "is_active": True,
            },
        )
        coupons_created += created

    customer = User.objects.get(email="customer@bitebox.test")
    address_created = False
    if not Address.objects.filter(user=customer).exists():
        Address.objects.create(
            user=customer,
            label="home",
            recipient_name=customer.name,
            phone=customer.phone or "9000000002",
            line1="Flat 4B, 80 Feet Road",
            area="Koramangala 4th Block",
            landmark="Near Forum Mall",
            city="Bengaluru",
            state="Karnataka",
            postal_code="560034",
            location=GeoPoint(lat=12.9352, lng=77.6271),  # about 4 km from the restaurant
            is_default=True,
        )
        address_created = True

    rider = User.objects.get(email="rider@bitebox.test")
    partner, rider_created = DeliveryPartner.objects.get_or_create(
        user=rider, defaults={"is_online": False}
    )
    RiderVehicle.objects.get_or_create(
        partner=partner, defaults={"vehicle_type": "motorbike", "vehicle_number": "KA 01 BB 0004"}
    )

    return SeedReport(
        users_created=users_created,
        passwords_reset=passwords_reset,
        categories_created=categories_created,
        restaurant_created=restaurant_created,
        food_items_created=food_items_created,
        coupons_created=coupons_created,
        customer_address_created=address_created,
        rider_profile_created=rider_created,
    )
