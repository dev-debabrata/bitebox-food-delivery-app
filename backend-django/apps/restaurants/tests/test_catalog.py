"""Port of the Node API's tests/catalog.test.js (restaurants, categories, dishes, uploads)."""

import base64
import shutil
from typing import Any
from urllib.parse import urlparse

import pytest
from django.conf import settings
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from apps.accounts.tests.test_auth import create_and_login, register, token_of
from apps.menus.models import FoodCategory, FoodItem
from apps.notifications.models import Notification
from apps.restaurants.models import Restaurant
from apps.uploads.storage import use_image_storage
from common.geo import GeoPoint
from common.seed import seed

pytestmark = pytest.mark.django_db

PASSWORD = "Sup3rSecret!1"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)


@pytest.fixture(autouse=True)
def _clean() -> Any:
    cache.clear()
    yield
    shutil.rmtree(settings.UPLOAD_DIR, ignore_errors=True)


def payload(**overrides: Any) -> dict[str, Any]:
    return {
        "name": "Tandoor Tales",
        "description": "Kebabs and curries",
        "cuisines": ["North Indian", "Mughlai"],
        "phone": "+919811112222",
        "address": {
            "line1": "5 MG Road",
            "city": "Bengaluru",
            "state": "Karnataka",
            "postalCode": "560001",
        },
        "location": {"latitude": 12.9756, "longitude": 77.6066},
        "costForTwoPaise": 60000,
        "openingTime": "11:00",
        "closingTime": "23:00",
        **overrides,
    }


def as_(token: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return client


def partner(**overrides: Any) -> str:
    res, _ = register(APIClient(), role="restaurant", **overrides)
    return token_of(res)


def seed_catalog() -> str:
    """The seeded Spice Route Kitchen (approved, 8 dishes); returns its owner's token."""
    seed(PASSWORD)
    return str(create_and_login("restaurant")["token"])


def other_restaurant(name: str = "Other Place") -> dict[str, Any]:
    token = partner()
    created = as_(token).post("/api/v1/my/restaurant", payload(name=name), format="json")
    assert created.status_code == 201, created.json()
    Restaurant.objects.filter(pk=created.json()["data"]["restaurant"]["id"]).update(
        status="approved"
    )
    return {"token": token, "restaurant": created.json()["data"]["restaurant"]}


def test_public_reads_are_cdn_cacheable_but_errors_never_are() -> None:
    listing = APIClient().get("/api/v1/categories")
    assert listing.status_code == 200
    assert "s-maxage=60" in listing["Cache-Control"]
    assert "public" in listing["Cache-Control"]
    missing = APIClient().get("/api/v1/restaurants/no-such-place")
    assert missing.status_code == 404
    assert missing["Cache-Control"] == "no-store"


# --- onboarding -----------------------------------------------------------------------------------


def test_creates_a_pending_restaurant_hidden_from_customers() -> None:
    res = as_(partner()).post("/api/v1/my/restaurant", payload(), format="json")
    assert res.status_code == 201
    r = res.json()["data"]["restaurant"]
    assert (r["status"], r["slug"]) == ("pending", "tandoor-tales")
    assert r["location"]["coordinates"] == [77.6066, 12.9756]
    assert APIClient().get("/api/v1/restaurants/tandoor-tales").status_code == 404
    assert APIClient().get("/api/v1/restaurants").json()["data"]["items"] == []


def test_ignores_client_attempts_to_set_status_owner_or_rating() -> None:
    res = as_(partner()).post(
        "/api/v1/my/restaurant",
        payload(
            status="approved",
            owner="00000000-0000-0000-0000-000000000000",
            rating={"average": 5, "count": 999},
        ),
        format="json",
    )
    assert res.status_code == 201
    assert res.json()["data"]["restaurant"]["status"] == "pending"
    assert res.json()["data"]["restaurant"]["rating"]["count"] == 0


def test_one_restaurant_per_partner() -> None:
    client = as_(partner())
    client.post("/api/v1/my/restaurant", payload(), format="json")
    assert (
        client.post("/api/v1/my/restaurant", payload(name="Second"), format="json").status_code
        == 409
    )


def test_validates_required_fields_and_coordinates() -> None:
    res = as_(partner()).post(
        "/api/v1/my/restaurant",
        payload(location={"latitude": 123, "longitude": 77}, openingTime="25:00", cuisines=[]),
        format="json",
    )
    assert res.status_code == 422
    fields = {d["field"] for d in res.json()["error"]["details"]}
    assert {"location.latitude", "openingTime", "cuisines"} <= fields


def test_non_partners_are_forbidden_from_partner_endpoints() -> None:
    res, _ = register(APIClient())
    customer = as_(token_of(res))
    assert customer.post("/api/v1/my/restaurant", payload(), format="json").status_code == 403
    assert customer.get("/api/v1/my/restaurant/foods").status_code == 403


def test_editing_a_rejected_restaurant_resubmits_it() -> None:
    client = as_(partner())
    created = client.post("/api/v1/my/restaurant", payload(), format="json").json()["data"][
        "restaurant"
    ]
    Restaurant.objects.filter(pk=created["id"]).update(
        status="rejected", status_reason="Blurry photos"
    )
    res = client.patch(
        "/api/v1/my/restaurant", {"description": "New photos uploaded"}, format="json"
    )
    assert res.status_code == 200
    assert res.json()["data"]["restaurant"]["status"] == "pending"
    assert "statusReason" not in res.json()["data"]["restaurant"]


def test_owner_pauses_and_resumes_orders() -> None:
    res = as_(seed_catalog()).patch(
        "/api/v1/my/restaurant/accepting-orders", {"isAcceptingOrders": False}, format="json"
    )
    assert res.status_code == 200
    r = res.json()["data"]["restaurant"]
    assert r["isAcceptingOrders"] is False
    assert r["isOpenNow"] is False


# --- admin approval -------------------------------------------------------------------------------


def pending_restaurant() -> str:
    res = as_(partner()).post("/api/v1/my/restaurant", payload(), format="json")
    return str(res.json()["data"]["restaurant"]["id"])


def test_approving_makes_the_restaurant_public() -> None:
    rid = pending_restaurant()
    admin = as_(create_and_login("admin")["token"])
    res = admin.patch(
        f"/api/v1/admin/restaurants/{rid}/status", {"status": "approved"}, format="json"
    )
    assert res.status_code == 200
    assert res.json()["data"]["restaurant"]["status"] == "approved"
    public = APIClient().get("/api/v1/restaurants/tandoor-tales")
    assert public.status_code == 200
    assert "owner" not in public.json()["data"]["restaurant"], "owner id is not exposed publicly"


def test_notifies_admins_of_applications_and_owners_of_decisions() -> None:
    admin_login = create_and_login("admin")
    admin = as_(admin_login["token"])
    owner_token = partner()
    owner = as_(owner_token)
    owner_id = owner.get("/api/v1/auth/me").json()["data"]["user"]["id"]

    rid = owner.post("/api/v1/my/restaurant", payload(), format="json").json()["data"][
        "restaurant"
    ]["id"]
    applied = Notification.objects.filter(user_id=admin_login["user"]["id"]).latest("created_at")
    assert "New restaurant application: Tandoor Tales" in applied.title
    assert applied.link == f"/admin/restaurants/{rid}"

    admin.patch(
        f"/api/v1/admin/restaurants/{rid}/status",
        {"status": "rejected", "reason": "Blurry photos"},
        format="json",
    )
    rejected = Notification.objects.filter(user_id=owner_id).latest("created_at")
    assert rejected.type == "restaurant.rejected"
    assert "Reason: Blurry photos" in rejected.body

    owner.patch("/api/v1/my/restaurant", {"description": "New photos uploaded"}, format="json")
    assert (
        "Restaurant resubmitted"
        in Notification.objects.filter(user_id=admin_login["user"]["id"]).latest("created_at").title
    )

    admin.patch(f"/api/v1/admin/restaurants/{rid}/status", {"status": "approved"}, format="json")
    approved = Notification.objects.filter(user_id=owner_id).latest("created_at")
    assert (approved.title, approved.link) == ("Your restaurant is live", "/restaurant")
    # application + resubmission, for the super admin and the operations admin
    assert (
        Notification.objects.filter(
            type="restaurant.review", user_id=admin_login["user"]["id"]
        ).count()
        == 2
    )


def test_reject_needs_a_reason_and_the_transition_table_holds() -> None:
    rid = pending_restaurant()
    admin = as_(create_and_login("admin")["token"])
    path = f"/api/v1/admin/restaurants/{rid}/status"
    assert admin.patch(path, {"status": "rejected"}, format="json").status_code == 400
    rejected = admin.patch(
        path, {"status": "rejected", "reason": "Missing FSSAI licence"}, format="json"
    )
    assert rejected.status_code == 200
    assert rejected.json()["data"]["restaurant"]["statusReason"] == "Missing FSSAI licence"
    assert (
        admin.patch(path, {"status": "suspended", "reason": "x"}, format="json").status_code == 409
    )


def test_suspending_hides_a_restaurant_and_its_dishes() -> None:
    seed_catalog()
    admin = as_(create_and_login("admin")["token"])
    r = Restaurant.objects.get(slug="spice-route-kitchen")
    admin.patch(
        f"/api/v1/admin/restaurants/{r.pk}/status",
        {"status": "suspended", "reason": "Hygiene audit"},
        format="json",
    )
    assert APIClient().get("/api/v1/restaurants/spice-route-kitchen").status_code == 404
    assert APIClient().get("/api/v1/foods?search=biryani").json()["data"]["items"] == []


def test_admin_lists_by_status_with_counts() -> None:
    pending_restaurant()
    seed_catalog()
    admin = as_(create_and_login("admin")["token"])
    listing = admin.get("/api/v1/admin/restaurants?status=pending")
    assert listing.status_code == 200
    items = listing.json()["data"]["items"]
    assert len(items) == 1
    assert items[0]["owner"]["email"].endswith("@example.com")
    counts = admin.get("/api/v1/admin/restaurants/counts").json()["data"]["counts"]
    assert counts == {"pending": 1, "approved": 1, "rejected": 0, "suspended": 0}


def test_non_admins_cannot_approve() -> None:
    rid = pending_restaurant()
    res = as_(create_and_login("restaurant")["token"]).patch(
        f"/api/v1/admin/restaurants/{rid}/status", {"status": "approved"}, format="json"
    )
    assert res.status_code == 403


# --- categories -----------------------------------------------------------------------------------


def test_creates_renames_and_lists_categories_customers_see_active_only() -> None:
    admin = as_(create_and_login("admin")["token"])
    FoodCategory.objects.update(is_active=False)  # hide the seeded ones
    created = admin.post(
        "/api/v1/admin/categories", {"name": "Rolls & Wraps", "icon": "kebab_dining"}, format="json"
    )
    assert created.status_code == 201
    assert created.json()["data"]["category"]["slug"] == "rolls-wraps"
    assert (
        admin.post("/api/v1/admin/categories", {"name": "rolls & wraps"}, format="json").status_code
        == 409
    )
    admin.patch(
        f"/api/v1/admin/categories/{created.json()['data']['category']['id']}",
        {"isActive": False},
        format="json",
    )
    assert APIClient().get("/api/v1/categories").json()["data"]["categories"] == []


def test_refuses_to_delete_a_category_menu_items_use() -> None:
    seed_catalog()
    admin = as_(create_and_login("admin")["token"])
    biryani = FoodCategory.objects.get(slug="biryani")
    assert admin.delete(f"/api/v1/admin/categories/{biryani.pk}").status_code == 409
    pizza = FoodCategory.objects.get(slug="pizza")
    assert admin.delete(f"/api/v1/admin/categories/{pizza.pk}").status_code == 200
    assert not FoodCategory.objects.filter(pk=pizza.pk).exists()


def test_non_admins_cannot_manage_categories() -> None:
    res = as_(create_and_login("restaurant")["token"]).post(
        "/api/v1/admin/categories", {"name": "Hacks"}, format="json"
    )
    assert res.status_code == 403


# --- menu management ------------------------------------------------------------------------------


def test_creates_items_with_server_validated_price_and_active_category() -> None:
    owner = as_(seed_catalog())
    pizza = FoodCategory.objects.get(slug="pizza")
    base = {"name": "Margherita", "category": str(pizza.pk), "pricePaise": 29900, "isVeg": True}
    res = owner.post(
        "/api/v1/my/restaurant/foods",
        {**base, "restaurant": "00000000-0000-0000-0000-000000000000"},
        format="json",
    )
    assert res.status_code == 201
    item = res.json()["data"]["item"]
    assert (item["pricePaise"], item["category"]["name"]) == (29900, "Pizza")
    kitchen = Restaurant.objects.get(slug="spice-route-kitchen")
    assert item["restaurant"] == str(kitchen.pk), "restaurant comes from the owner, not the body"

    assert (
        owner.post(
            "/api/v1/my/restaurant/foods", {**base, "name": "Free", "pricePaise": 50}, format="json"
        ).status_code
        == 422
    )
    assert (
        owner.post(
            "/api/v1/my/restaurant/foods",
            {**base, "name": "Odd", "pricePaise": 199.5},
            format="json",
        ).status_code
        == 422
    )
    assert (
        owner.post(
            "/api/v1/my/restaurant/foods",
            {**base, "name": "margherita", "pricePaise": 100},
            format="json",
        ).status_code
        == 409
    )


def test_rejects_inactive_categories() -> None:
    owner = as_(seed_catalog())
    FoodCategory.objects.filter(slug="pizza").update(is_active=False)
    pizza = FoodCategory.objects.get(slug="pizza")
    res = owner.post(
        "/api/v1/my/restaurant/foods",
        {"name": "Margherita", "category": str(pizza.pk), "pricePaise": 29900, "isVeg": True},
        format="json",
    )
    assert res.status_code == 422


def _menu_items() -> list[dict[str, Any]]:
    sections = (
        APIClient().get("/api/v1/restaurants/spice-route-kitchen/menu").json()["data"]["sections"]
    )
    return [i for s in sections for i in s["items"]]


def test_toggles_availability_and_soft_deletes_items() -> None:
    owner = as_(seed_catalog())
    dosa = FoodItem.objects.get(name="Masala Dosa")
    off = owner.patch(
        f"/api/v1/my/restaurant/foods/{dosa.pk}/availability", {"isAvailable": False}, format="json"
    )
    assert off.status_code == 200
    assert off.json()["data"]["item"]["isAvailable"] is False
    listed = next(i for i in _menu_items() if i["name"] == "Masala Dosa")
    assert listed["isAvailable"] is False, "unavailable items stay on the menu, flagged"
    assert APIClient().get("/api/v1/foods?search=dosa").json()["data"]["items"] == []

    assert owner.delete(f"/api/v1/my/restaurant/foods/{dosa.pk}").status_code == 200
    assert all(i["name"] != "Masala Dosa" for i in _menu_items())
    assert FoodItem.objects.filter(pk=dosa.pk, deleted_at__isnull=False).exists(), (
        "kept for history"
    )


def test_partners_cannot_touch_another_restaurants_items() -> None:
    seed_catalog()
    intruder = as_(other_restaurant()["token"])
    item = FoodItem.objects.get(name="Butter Chicken")
    assert (
        intruder.patch(
            f"/api/v1/my/restaurant/foods/{item.pk}", {"pricePaise": 100}, format="json"
        ).status_code
        == 404
    )
    assert (
        intruder.patch(
            f"/api/v1/my/restaurant/foods/{item.pk}/availability",
            {"isAvailable": False},
            format="json",
        ).status_code
        == 404
    )
    assert intruder.delete(f"/api/v1/my/restaurant/foods/{item.pk}").status_code == 404
    assert intruder.get("/api/v1/my/restaurant/foods").json()["data"]["items"] == []
    assert FoodItem.objects.get(pk=item.pk).price_paise == 34900


def test_a_menu_needs_a_restaurant_profile_first() -> None:
    client = as_(partner())
    assert client.get("/api/v1/my/restaurant/foods").status_code == 404
    assert client.get("/api/v1/my/restaurant").json()["data"]["restaurant"] is None


# --- discovery ------------------------------------------------------------------------------------


def _names(path: str) -> list[str]:
    return [r["name"] for r in APIClient().get(path).json()["data"]["items"]]


def test_searches_restaurants_by_name_cuisine_and_dish() -> None:
    seed_catalog()
    other_restaurant("Pizza Planet")
    assert _names("/api/v1/restaurants?search=spice") == ["Spice Route Kitchen"]
    assert _names("/api/v1/restaurants?search=mughlai") == ["Pizza Planet"]
    assert _names("/api/v1/restaurants?search=lassi") == ["Spice Route Kitchen"]


def test_filters_by_veg_cuisine_and_category() -> None:
    seed_catalog()
    other = other_restaurant("Green Leaf")
    Restaurant.objects.filter(pk=other["restaurant"]["id"]).update(is_pure_veg=True)
    assert _names("/api/v1/restaurants?veg=true") == ["Green Leaf"]
    assert _names("/api/v1/restaurants?cuisine=biryani") == ["Spice Route Kitchen"]
    desserts = FoodCategory.objects.get(slug="desserts")
    assert _names(f"/api/v1/restaurants?category={desserts.pk}") == ["Spice Route Kitchen"]


def test_finds_nearby_restaurants_with_straight_line_distance() -> None:
    seed_catalog()  # Indiranagar, Bengaluru
    far = other_restaurant("Mumbai Masala")
    Restaurant.objects.filter(pk=far["restaurant"]["id"]).update(
        location=GeoPoint(lat=19.076, lng=72.8777)
    )
    res = APIClient().get("/api/v1/restaurants?lat=12.9716&lng=77.5946&radiusKm=10")
    assert res.status_code == 200
    items = res.json()["data"]["items"]
    assert [r["name"] for r in items] == ["Spice Route Kitchen"]
    assert 4000 < items[0]["distanceMeters"] < 6000


def test_distance_sort_needs_coordinates_and_both_halves() -> None:
    assert APIClient().get("/api/v1/restaurants?sort=distance").status_code == 400
    assert APIClient().get("/api/v1/restaurants?lat=12.9").status_code == 422
    assert APIClient().get("/api/v1/restaurants?lng=77.5").status_code == 422


def test_paginates_results() -> None:
    seed_catalog()
    other_restaurant("Second Spot")
    page1 = APIClient().get("/api/v1/restaurants?limit=1&page=1&sort=newest").json()["data"]
    page2 = APIClient().get("/api/v1/restaurants?limit=1&page=2&sort=newest").json()["data"]
    assert (page1["pagination"]["total"], page1["pagination"]["totalPages"]) == (2, 2)
    assert page1["items"][0]["id"] != page2["items"][0]["id"]


def test_menu_is_grouped_by_category_in_category_order() -> None:
    seed_catalog()
    sections = (
        APIClient().get("/api/v1/restaurants/spice-route-kitchen/menu").json()["data"]["sections"]
    )
    assert [s["category"]["name"] for s in sections] == [
        "Biryani",
        "North Indian",
        "South Indian",
        "Desserts",
        "Beverages",
    ]


def test_dish_search_covers_approved_restaurants_only() -> None:
    seed_catalog()
    hidden = other_restaurant("Hidden Biryani House")
    Restaurant.objects.filter(pk=hidden["restaurant"]["id"]).update(status="pending")
    FoodItem.objects.create(
        restaurant_id=hidden["restaurant"]["id"],
        category=FoodCategory.objects.get(slug="biryani"),
        name="Secret Biryani",
        price_paise=20000,
        is_veg=False,
    )
    res = APIClient().get("/api/v1/foods?search=biryani").json()["data"]["items"]
    assert sorted(i["name"] for i in res) == ["Hyderabadi Chicken Biryani", "Paneer Tikka Biryani"]
    assert res[0]["restaurant"]["slug"] == "spice-route-kitchen"
    assert _names("/api/v1/foods?search=biryani&veg=true") == ["Paneer Tikka Biryani"]


def test_dish_details_include_the_restaurants_open_state() -> None:
    seed_catalog()
    lassi = FoodItem.objects.get(name="Mango Lassi")
    res = APIClient().get(f"/api/v1/foods/{lassi.pk}")
    assert res.status_code == 200
    restaurant = res.json()["data"]["item"]["restaurant"]
    assert restaurant["name"] == "Spice Route Kitchen"
    assert isinstance(restaurant["isOpenNow"], bool)


# --- uploads --------------------------------------------------------------------------------------


def upload(
    token: str, data: bytes = PNG, name: str = "photo.png", content_type: str = "image/png"
) -> Any:
    return as_(token).post(
        "/api/v1/uploads/images",
        {"image": SimpleUploadedFile(name, data, content_type=content_type)},
        format="multipart",
    )


def test_stores_a_real_image_under_a_random_name_and_serves_it_cross_origin() -> None:
    res = upload(create_and_login("restaurant")["token"])
    assert res.status_code == 201
    data = res.json()["data"]
    assert data["type"] == "png"
    path = urlparse(data["url"]).path
    assert path.startswith("/uploads/images/")
    assert path.endswith(".png")
    assert len(path.split("/")[-1]) == 40
    served = APIClient().get(path)
    assert served.status_code == 200
    assert served["Cross-Origin-Resource-Policy"] == "cross-origin"
    assert served["X-Content-Type-Options"] == "nosniff"


class FakeCloud:
    def __init__(self, fail: bool = False) -> None:
        self.fail, self.sent = fail, []

    def save(self, data: bytes, extension: str) -> str:
        if self.fail:
            raise OSError("network down")
        self.sent.append(len(data))
        return "https://res.cloudinary.com/demo-cloud/image/upload/f_auto,q_auto/v1700000000/bitebox/abc123"


def test_uploads_go_to_the_configured_storage_and_failures_are_503() -> None:
    token = create_and_login("restaurant")["token"]
    cloud = FakeCloud()
    with use_image_storage(cloud):
        res = upload(token)
    assert res.status_code == 201
    assert res.json()["data"]["url"].startswith("https://res.cloudinary.com/demo-cloud/")
    assert cloud.sent == [len(PNG)], "the checked bytes are what gets uploaded"
    with use_image_storage(FakeCloud(fail=True)):
        failed = upload(token)
    assert failed.status_code == 503
    assert failed.json()["error"]["code"] == "UPLOAD_FAILED"


def test_rejects_files_whose_bytes_are_not_an_image() -> None:
    res = upload(create_and_login("admin")["token"], b"<script>alert(1)</script>", "evil.png")
    assert res.status_code == 415


def test_rejects_files_over_2mb() -> None:
    res = upload(create_and_login("restaurant")["token"], PNG + bytes(2 * 1024 * 1024), "big.png")
    assert res.status_code == 413


def test_only_partners_and_admins_upload_menu_images() -> None:
    res, _ = register(APIClient())
    assert upload(token_of(res)).status_code == 403


def test_absent_boolean_filters_are_not_false() -> None:
    """Regression: DRF reads a missing boolean query parameter as false unless told otherwise."""
    owner = as_(seed_catalog())
    total = owner.get("/api/v1/my/restaurant/foods").json()["data"]["pagination"]["total"]
    assert total == 8
    assert owner.get("/api/v1/my/restaurant/foods?available=false").json()["data"]["items"] == []
