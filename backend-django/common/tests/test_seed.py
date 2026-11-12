import pytest
from django.core.management import CommandError, call_command

from apps.accounts.models import User
from apps.coupons.models import Coupon
from apps.customers.models import Address
from apps.delivery.models import DeliveryPartner
from apps.menus.models import FoodCategory, FoodItem
from apps.restaurants.models import Restaurant
from common.seed import SEED_USERS, seed, valid_seed_password

pytestmark = pytest.mark.django_db
PASSWORD = "Seed-pass-123"


def counts() -> tuple[int, ...]:
    return (
        User.objects.count(),
        FoodCategory.objects.count(),
        Restaurant.objects.count(),
        FoodItem.objects.count(),
        Coupon.objects.count(),
        Address.objects.count(),
        DeliveryPartner.objects.count(),
    )


def test_seed_creates_the_node_dataset_and_is_idempotent() -> None:
    first = seed(PASSWORD)
    assert len(first.users_created) == len(SEED_USERS) == 7
    assert counts() == (7, 8, 1, 8, 2, 1, 1)
    restaurant = Restaurant.objects.get(slug="spice-route-kitchen")
    assert restaurant.owner.email == "restaurant@bitebox.test"
    assert restaurant.status == "approved"
    assert User.objects.get(email="admin@bitebox.test").check_password(PASSWORD)
    assert DeliveryPartner.objects.get().vehicle.vehicle_type == "motorbike"

    again = seed(PASSWORD)
    assert again.users_created == []
    assert again.food_items_created == 0
    assert counts() == (7, 8, 1, 8, 2, 1, 1)


def test_reset_passwords_signs_users_out() -> None:
    seed(PASSWORD)
    report = seed("Other-pass-456", reset_passwords=True)
    assert report.passwords_reset == 7
    admin = User.objects.get(email="admin@bitebox.test")
    assert admin.check_password("Other-pass-456")
    assert admin.token_version == 1


@pytest.mark.parametrize(
    ("password", "ok"), [("short1", False), ("lettersonly", False), ("Dev-pass-123", True)]
)
def test_seed_password_rule(password: str, ok: bool) -> None:
    assert valid_seed_password(password) is ok


def test_command_requires_a_valid_password(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SEED_PASSWORD", raising=False)
    with pytest.raises(CommandError, match="SEED_PASSWORD"):
        call_command("seed")


def test_command_refuses_production_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DJANGO_SETTINGS_MODULE", "config.settings.production")
    monkeypatch.setenv("SEED_PASSWORD", PASSWORD)
    with pytest.raises(CommandError, match="Refusing"):
        call_command("seed")
