"""
Port of the Node API's tests/checkout.test.js (pricing, cart, addresses, coupons) and the coupon
and address parts of tests/admin.test.js. Placing orders is Phase 7.
"""

from datetime import timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.tests.test_auth import create_and_login, register, token_of
from apps.cart.pricing import PRICING, compute_pricing, coupon_discount, delivery_fee, js_round
from apps.coupons.models import Coupon, CouponRedemption
from apps.customers.models import Address
from apps.menus.models import FoodItem
from apps.restaurants.models import Restaurant
from common.seed import seed
from tests import factories as make

pytestmark = pytest.mark.django_db
PASSWORD = "Sup3rSecret!1"
ADDRESS = {
    "recipientName": "Asha",
    "phone": "9000000002",
    "line1": "Flat 4B, 80 Feet Road",
    "city": "Bengaluru",
    "state": "Karnataka",
    "postalCode": "560034",
    "location": {"latitude": 12.9352, "longitude": 77.6271},  # ~4 km from the seeded restaurant
}


# --- pricing rules (pure functions) ---------------------------------------------------------------


def c(**kw: Any) -> SimpleNamespace:
    return SimpleNamespace(**{"max_discount_paise": None, **kw})


def test_caps_percentage_coupons_and_never_discounts_more_than_the_subtotal() -> None:
    assert (
        coupon_discount(
            c(discount_type="percent", discount_value=50, max_discount_paise=10000), 50000
        )
        == 10000
    )
    assert coupon_discount(c(discount_type="percent", discount_value=10), 33333) == 3333
    assert coupon_discount(c(discount_type="flat", discount_value=7500), 5000) == 5000


def test_delivery_by_straight_line_distance_with_a_cap_and_a_free_threshold() -> None:
    assert delivery_fee(1500, 10000) == PRICING["delivery_base_fee_paise"]
    assert (
        delivery_fee(4200, 10000)
        == PRICING["delivery_base_fee_paise"] + 3 * PRICING["delivery_per_km_paise"]
    )
    assert delivery_fee(14000, 10000) == PRICING["delivery_max_fee_paise"]
    assert delivery_fee(4200, PRICING["free_delivery_threshold_paise"]) == 0


def test_tax_on_the_discounted_subtotal() -> None:
    p = compute_pricing(30000, c(discount_type="flat", discount_value=5000), 1000)
    assert p.as_dict() == {
        "subtotal_paise": 30000,
        "discount_paise": 5000,
        "delivery_fee_paise": 2500,
        "platform_fee_paise": 500,
        "tax_paise": 1250,
        "coin_discount_paise": 0,
        "total_paise": 25000 + 2500 + 500 + 1250,
    }


def test_coins_come_off_the_total_without_changing_tax_or_fees() -> None:
    p = compute_pricing(30000, None, 1000, 2000)
    assert (p.tax_paise, p.delivery_fee_paise, p.coin_discount_paise) == (1500, 2500, 2000)
    assert p.total_paise == 30000 + 2500 + 500 + 1500 - 2000
    assert compute_pricing(100, coin_discount_paise=99_999).total_paise == 0


def test_rounding_matches_javascript() -> None:
    # 5% of 4510 = 225.5: JavaScript rounds up (226); Python's round() would give 226 too, but
    # 5% of 4530 = 226.5 → JavaScript 227, Python round() 226.
    assert js_round(226.5) == 227
    assert compute_pricing(4530).tax_paise == 227


# --- cart -----------------------------------------------------------------------------------------


@pytest.fixture
def ctx() -> dict[str, Any]:
    """Seeded catalogue + checkout data, restaurant open 24 hours, signed-in customer."""
    cache.clear()
    seed(PASSWORD)
    Restaurant.objects.filter(slug="spice-route-kitchen").update(
        opening_time="00:00", closing_time="00:00"
    )
    customer = create_and_login("customer")
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {customer['token']}")
    food = {f.name: f for f in FoodItem.objects.all()}
    return {"client": client, "customer": customer, "food": food}


def add(client: APIClient, food: FoodItem, quantity: int = 1, **extra: Any) -> Any:
    return client.post(
        "/api/v1/cart/items",
        {"foodItemId": str(food.pk), "quantity": quantity, **extra},
        format="json",
    )


def test_prices_items_from_the_database_and_ignores_client_prices(ctx: dict[str, Any]) -> None:
    res = add(ctx["client"], ctx["food"]["Butter Chicken"], 2, pricePaise=1, unitPricePaise=1)
    assert res.status_code == 200
    q = res.json()["data"]
    assert q["cart"]["items"][0]["unitPricePaise"] == 34900
    assert q["pricing"]["subtotalPaise"] == 69800
    assert q["cart"]["itemCount"] == 2
    assert q["delivery"]["distanceKind"] == "straight_line"


def test_increments_caps_and_removes_quantities(ctx: dict[str, Any]) -> None:
    client, naan = ctx["client"], ctx["food"]["Garlic Naan"]
    add(client, naan, 15)
    assert add(client, naan, 10).json()["data"]["cart"]["items"][0]["quantity"] == 20
    assert add(client, naan, 25).status_code == 422
    path = f"/api/v1/cart/items/{naan.pk}"
    assert (
        client.patch(path, {"quantity": 3}, format="json").json()["data"]["cart"]["items"][0][
            "quantity"
        ]
        == 3
    )
    assert client.patch(path, {"quantity": 0}, format="json").json()["data"]["cart"] is None


def test_one_restaurant_per_cart_unless_starting_over(ctx: dict[str, Any]) -> None:
    client = ctx["client"]
    add(client, ctx["food"]["Garlic Naan"])
    other = make.restaurant(
        name="Other Place", slug="other-place", opening_time="00:00", closing_time="00:00"
    )
    bhaji = make.food(
        restaurant=other,
        category=ctx["food"]["Garlic Naan"].category,
        name="Pav Bhaji",
        price_paise=15000,
    )
    conflict = add(client, bhaji)
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "CART_RESTAURANT_CONFLICT"
    replaced = add(client, bhaji, 1, replace=True)
    assert replaced.status_code == 200
    assert [i["name"] for i in replaced.json()["data"]["cart"]["items"]] == ["Pav Bhaji"]


def test_refuses_unavailable_dishes_and_blocks_checkout_if_one_becomes_unavailable(
    ctx: dict[str, Any],
) -> None:
    client, food = ctx["client"], ctx["food"]
    FoodItem.objects.filter(pk=food["Mango Lassi"].pk).update(is_available=False)
    assert add(client, food["Mango Lassi"]).status_code == 409
    add(client, food["Butter Chicken"])
    FoodItem.objects.filter(pk=food["Butter Chicken"].pk).update(is_available=False)
    q = client.get("/api/v1/cart").json()["data"]
    assert q["canCheckout"] is False
    assert any(i["code"] == "ITEMS_UNAVAILABLE" for i in q["issues"])
    assert q["pricing"]["subtotalPaise"] == 0


def test_reports_closed_restaurants_minimum_order_and_distance(ctx: dict[str, Any]) -> None:
    client = ctx["client"]
    add(client, ctx["food"]["Garlic Naan"])  # ₹69 < ₹150 minimum
    q = client.get("/api/v1/cart").json()["data"]
    below = next(i for i in q["issues"] if i["code"] == "BELOW_MINIMUM")
    assert below["message"] == "Minimum order is ₹150. Add ₹81 more."
    Restaurant.objects.filter(slug="spice-route-kitchen").update(is_accepting_orders=False)
    q = client.get("/api/v1/cart").json()["data"]
    assert any(i["code"] == "RESTAURANT_CLOSED" for i in q["issues"])
    far = client.post(
        "/api/v1/addresses",
        {**ADDRESS, "city": "Mysuru", "location": {"latitude": 12.2958, "longitude": 76.6394}},
        format="json",
    ).json()["data"]["address"]
    q = client.get(f"/api/v1/cart?addressId={far['id']}").json()["data"]
    assert any(i["code"] == "OUT_OF_RANGE" for i in q["issues"])


def test_cart_is_for_customers_only(ctx: dict[str, Any]) -> None:
    owner = APIClient()
    owner.credentials(HTTP_AUTHORIZATION=f"Bearer {create_and_login('restaurant')['token']}")
    assert owner.get("/api/v1/cart").status_code == 403
    assert APIClient().get("/api/v1/cart").status_code == 401


def test_empty_cart_quote(ctx: dict[str, Any]) -> None:
    q = ctx["client"].get("/api/v1/cart").json()["data"]
    assert q["cart"] is None
    assert q["canCheckout"] is False
    assert q["pricing"]["totalPaise"] == 0


# --- addresses ------------------------------------------------------------------------------------


def fresh_customer() -> APIClient:
    res, _ = register(APIClient())
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_of(res)}")
    return client


def test_manages_defaults_and_keeps_addresses_private(ctx: dict[str, Any]) -> None:
    client = fresh_customer()
    first = client.post("/api/v1/addresses", ADDRESS, format="json")
    assert first.status_code == 201
    assert first.json()["data"]["address"]["isDefault"] is True, "first address becomes default"
    second = client.post(
        "/api/v1/addresses", {**ADDRESS, "label": "work", "isDefault": True}, format="json"
    ).json()["data"]["address"]
    listed = client.get("/api/v1/addresses").json()["data"]["addresses"]
    assert [(a["label"], a["isDefault"]) for a in listed] == [("work", True), ("home", False)]
    client.delete(f"/api/v1/addresses/{second['id']}")
    assert client.get("/api/v1/addresses").json()["data"]["addresses"][0]["isDefault"] is True, (
        "remaining promoted"
    )
    first_id = first.json()["data"]["address"]["id"]
    assert (
        ctx["client"]
        .patch(f"/api/v1/addresses/{first_id}", {"city": "Hacked"}, format="json")
        .status_code
        == 404
    )


def test_validates_coordinates_and_required_fields(ctx: dict[str, Any]) -> None:
    res = ctx["client"].post(
        "/api/v1/addresses",
        {**ADDRESS, "postalCode": "!", "location": {"latitude": 200, "longitude": 77}},
        format="json",
    )
    assert res.status_code == 422
    assert {"postalCode", "location.latitude"} <= {
        d["field"] for d in res.json()["error"]["details"]
    }


def test_edits_switches_default_and_deletes(ctx: dict[str, Any]) -> None:
    client = fresh_customer()
    home = client.post("/api/v1/addresses", ADDRESS, format="json").json()["data"]["address"]
    work = client.post(
        "/api/v1/addresses", {**ADDRESS, "label": "work", "line1": "12 Office Park"}, format="json"
    ).json()["data"]["address"]
    assert work["isDefault"] is False
    edited = client.patch(
        f"/api/v1/addresses/{work['id']}", {"landmark": "Opposite the bakery"}, format="json"
    )
    assert edited.status_code == 200
    assert edited.json()["data"]["address"]["landmark"] == "Opposite the bakery"
    switched = client.patch(f"/api/v1/addresses/{work['id']}/default")
    assert switched.json()["data"]["address"]["isDefault"] is True
    assert Address.objects.get(pk=home["id"]).is_default is False, "only one default at a time"
    assert client.delete(f"/api/v1/addresses/{home['id']}").status_code == 200
    assert [a["id"] for a in client.get("/api/v1/addresses").json()["data"]["addresses"]] == [
        work["id"]
    ]


def test_other_customers_never_see_or_change_an_address(ctx: dict[str, Any]) -> None:
    mine = ctx["client"].post("/api/v1/addresses", ADDRESS, format="json").json()["data"]["address"]
    other = fresh_customer()
    assert (
        other.patch(f"/api/v1/addresses/{mine['id']}", {"landmark": "x"}, format="json").status_code
        == 404
    )
    assert other.patch(f"/api/v1/addresses/{mine['id']}/default").status_code == 404
    assert other.delete(f"/api/v1/addresses/{mine['id']}").status_code == 404
    assert other.get("/api/v1/addresses").json()["data"]["addresses"] == []


# --- coupons --------------------------------------------------------------------------------------


def test_applies_a_valid_coupon_and_recomputes_the_discount(ctx: dict[str, Any]) -> None:
    client = ctx["client"]
    add(client, ctx["food"]["Butter Chicken"], 2)  # ₹698
    res = client.post("/api/v1/cart/coupon", {"code": "welcome50"}, format="json")
    assert res.status_code == 200
    assert res.json()["data"]["coupon"]["code"] == "WELCOME50"
    assert res.json()["data"]["pricing"]["discountPaise"] == 10000, "50% capped at ₹100"


def test_rejects_unknown_expired_below_minimum_and_wrong_restaurant_coupons(
    ctx: dict[str, Any],
) -> None:
    client = ctx["client"]
    add(client, ctx["food"]["Masala Dosa"])  # ₹149
    apply = lambda code: client.post("/api/v1/cart/coupon", {"code": code}, format="json")  # noqa: E731
    assert apply("NOPE123").status_code == 422
    below = apply("WELCOME50")
    assert below.status_code == 422
    assert below.json()["error"]["code"] == "COUPON_MIN_ORDER"
    old = timezone.now() - timedelta(days=400)
    Coupon.objects.create(
        code="OLD10",
        discount_type="flat",
        discount_value=1000,
        valid_from=old,
        valid_until=old + timedelta(days=31),
    )
    assert "expired" in apply("OLD10").json()["message"]
    Coupon.objects.create(
        code="ELSEWHERE",
        discount_type="flat",
        discount_value=1000,
        valid_from=timezone.now() - timedelta(seconds=1),
        valid_until=timezone.now() + timedelta(days=1),
        restaurant=make.restaurant(),
    )
    assert "not valid at this restaurant" in apply("ELSEWHERE").json()["message"]


def test_drops_a_coupon_when_the_cart_no_longer_qualifies(ctx: dict[str, Any]) -> None:
    client, chicken = ctx["client"], ctx["food"]["Butter Chicken"]
    add(client, chicken, 2)
    client.post("/api/v1/cart/coupon", {"code": "FLAT75"}, format="json")
    q = client.patch(f"/api/v1/cart/items/{chicken.pk}", {"quantity": 1}, format="json").json()[
        "data"
    ]
    assert q["coupon"] is None
    assert q["couponError"]["code"] == "FLAT75"
    assert q["pricing"]["discountPaise"] == 0
    assert q["canCheckout"] is False


def test_available_coupons_list(ctx: dict[str, Any]) -> None:
    codes = [
        c["code"] for c in ctx["client"].get("/api/v1/coupons/available").json()["data"]["coupons"]
    ]
    assert sorted(codes) == ["FLAT75", "WELCOME50"]


def test_coins_need_a_balance(ctx: dict[str, Any]) -> None:
    client = ctx["client"]
    add(client, ctx["food"]["Butter Chicken"], 2)
    res = client.put("/api/v1/cart/coins", {"coins": 100}, format="json")
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "COINS_NOT_REDEEMABLE"
    assert client.get("/api/v1/cart").json()["data"]["coins"]["available"] == 0


# --- admin coupons --------------------------------------------------------------------------------


def coupon_body(**overrides: Any) -> dict[str, Any]:
    return {
        "code": "SAVE10",
        "discountType": "percent",
        "discountValue": 10,
        "validFrom": "2026-01-01T00:00:00Z",
        "validUntil": "2027-12-31T00:00:00Z",
        **overrides,
    }


@pytest.fixture
def admin() -> APIClient:
    cache.clear()
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {create_and_login('admin')['token']}")
    Coupon.objects.all().delete()  # without the seeded coupons
    return client


def test_creates_lists_searches_updates_and_deletes_coupons(admin: APIClient) -> None:
    created = admin.post("/api/v1/admin/coupons", coupon_body(code="spring25"), format="json")
    assert created.status_code == 201, created.json()
    coupon = created.json()["data"]["coupon"]
    assert coupon["code"] == "SPRING25", "codes are stored upper-case"
    admin.post(
        "/api/v1/admin/coupons",
        coupon_body(code="FLAT50", discountType="flat", discountValue=5000),
        format="json",
    )
    assert len(admin.get("/api/v1/admin/coupons").json()["data"]["items"]) == 2
    found = admin.get("/api/v1/admin/coupons?search=spring").json()["data"]["items"]
    assert [c["code"] for c in found] == ["SPRING25"]
    updated = admin.patch(
        f"/api/v1/admin/coupons/{coupon['id']}",
        {"isActive": False, "maxDiscountPaise": None},
        format="json",
    )
    assert updated.status_code == 200
    assert updated.json()["data"]["coupon"]["isActive"] is False
    assert updated.json()["data"]["coupon"]["maxDiscountPaise"] is None
    inactive = admin.get("/api/v1/admin/coupons?active=false").json()["data"]["items"]
    assert [c["code"] for c in inactive] == ["SPRING25"]
    assert admin.delete(f"/api/v1/admin/coupons/{coupon['id']}").status_code == 200
    assert admin.delete(f"/api/v1/admin/coupons/{coupon['id']}").status_code == 404


def test_validates_coupons_and_refuses_duplicate_codes(admin: APIClient) -> None:
    bad = admin.post("/api/v1/admin/coupons", coupon_body(code="x", discountValue=0), format="json")
    assert bad.status_code == 422
    assert {"code", "discountValue"} <= {d["field"] for d in bad.json()["error"]["details"]}
    assert (
        admin.post(
            "/api/v1/admin/coupons", coupon_body(code="BAD100", discountValue=150), format="json"
        ).status_code
        == 422
    )
    assert (
        admin.post(
            "/api/v1/admin/coupons",
            coupon_body(code="BACK", validUntil="2025-01-01T00:00:00Z"),
            format="json",
        ).status_code
        == 422
    )
    admin.post("/api/v1/admin/coupons", coupon_body(), format="json")
    assert admin.post("/api/v1/admin/coupons", coupon_body(), format="json").status_code == 409


def test_null_clears_cap_and_usage_limit(admin: APIClient) -> None:
    created = admin.post(
        "/api/v1/admin/coupons", coupon_body(maxDiscountPaise=8000, usageLimit=5), format="json"
    ).json()["data"]["coupon"]
    cleared = admin.patch(
        f"/api/v1/admin/coupons/{created['id']}",
        {"maxDiscountPaise": None, "usageLimit": None},
        format="json",
    )
    assert cleared.status_code == 200
    assert (
        cleared.json()["data"]["coupon"]["maxDiscountPaise"],
        cleared.json()["data"]["coupon"]["usageLimit"],
    ) == (None, None)


def test_keeps_used_coupons(admin: APIClient) -> None:
    created = admin.post("/api/v1/admin/coupons", coupon_body(), format="json").json()["data"][
        "coupon"
    ]
    order = make.order()
    CouponRedemption.objects.create(
        coupon_id=created["id"], user=order.customer, order=order, discount_paise=5000
    )
    assert admin.delete(f"/api/v1/admin/coupons/{created['id']}").status_code == 409


def test_admin_coupons_are_for_admins_only(admin: APIClient) -> None:
    customer = APIClient()
    customer.credentials(HTTP_AUTHORIZATION=f"Bearer {create_and_login('customer')['token']}")
    assert customer.get("/api/v1/admin/coupons").status_code == 403
    owner = APIClient()
    owner.credentials(HTTP_AUTHORIZATION=f"Bearer {create_and_login('restaurant')['token']}")
    assert owner.post("/api/v1/admin/coupons", coupon_body(), format="json").status_code == 403
    assert APIClient().get("/api/v1/admin/coupons").status_code == 401
