"""
Port of the Node API's tests/coins-checkout.test.js: coins at checkout (held, spent, given back),
the order and review rewards, the customer wallet API and the rewards sweep. Orders are driven
through the real API and workflow. Two Butter Chicken = ₹698 food value.
"""

from datetime import timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.coins import config as reward_config
from apps.coins import orders as coin_orders
from apps.coins import wallet
from apps.coins.models import CoinTransaction, CoinWallet
from apps.coins.quote import get_reward_config, redemption_quote
from apps.coins.tasks import rewards_sweep
from apps.dispatch.config import DISPATCH
from apps.dispatch.services import sweep
from apps.notifications.models import Notification
from apps.orders.models import Order
from apps.orders.tests.test_orders import client_for
from apps.payments.models import Payment
from apps.reviews.models import Review

from .helpers import RewardsWorld

pytestmark = pytest.mark.django_db


@pytest.fixture
def w() -> RewardsWorld:
    return RewardsWorld()


def set_coins(w: RewardsWorld, coins: Any) -> Any:
    return w.c.put("/api/v1/cart/coins", {"coins": coins}, format="json")


# --- earning ------------------------------------------------------------------------------------


def test_credits_coins_once_for_a_delivered_order_on_the_food_value(w: RewardsWorld) -> None:
    order = w.place_as()
    w.deliver(order["id"])
    # ₹698 food value -> 6 x ₹100 -> 60 coins (fees and tax are not counted).
    saved = Order.objects.get(pk=order["id"])
    assert saved.coins_earned == 60
    assert w.coins_of(w.me) == 60
    assert Notification.objects.filter(user_id=w.me, type="coins.earned").count() == 1
    assert w.c.get(f"/api/v1/orders/{order['id']}").json()["data"]["order"]["coins"]["earned"] == 60
    # Repeating the delivery follow-up does not pay again.
    coin_orders.reward_delivered_order(saved)
    assert w.coins_of(w.me) == 60
    assert CoinTransaction.objects.filter(source="ORDER_REWARD").count() == 1


def test_gives_nothing_for_rejected_orders(w: RewardsWorld) -> None:
    order = w.place_as()
    assert w.reject(order["id"]).status_code == 200
    assert not CoinTransaction.objects.filter(user_id=w.me).exists()


def test_follows_the_configured_earning_rule_and_switches() -> None:
    config = get_reward_config()
    order = SimpleNamespace(subtotal_paise=69_800, discount_paise=9_800, coin_discount_paise=1_000)
    assert coin_orders.order_reward_coins(order, config) == 50  # ₹590 -> 5 x 10
    capped = {**config, "earning": {**config["earning"], "order": {**config["earning"]["order"], "max_coins_per_order": 30}}}
    assert coin_orders.order_reward_coins(order, capped) == 30
    assert coin_orders.order_reward_coins(order, {**config, "coins_enabled": False}) == 0
    high = {**config, "earning": {**config["earning"], "order": {**config["earning"]["order"], "min_order_paise": 60_000}}}
    assert coin_orders.order_reward_coins(order, high) == 0


def test_pays_the_review_bonus_once_and_takes_it_back_when_deleted(w: RewardsWorld) -> None:
    order_id = w.place_as()["id"]
    w.deliver(order_id)
    review = w.c.post(
        f"/api/v1/orders/{order_id}/reviews",
        {"restaurant": 5, "comment": "Lovely food, arrived hot."},
        format="json",
    )
    assert review.status_code == 201, review.json()
    assert w.coins_of(w.me) == 65
    again = w.c.post(f"/api/v1/orders/{order_id}/reviews", {"restaurant": 4}, format="json")
    assert again.status_code == 409
    w.c.post(f"/api/v1/orders/{order_id}/reviews", {"rider": 5}, format="json")
    assert w.coins_of(w.me) == 65

    review_id = Review.objects.get(order_id=order_id, target="restaurant").pk
    assert w.c.delete(f"/api/v1/reviews/{review_id}").status_code == 200
    b = w.balance()
    assert (b.available, b.total_reversed) == (60, 5)
    w.reconciled()


def test_moderation_removing_a_review_takes_the_bonus_back(w: RewardsWorld) -> None:
    order_id = w.place_as()["id"]
    w.deliver(order_id)
    w.c.post(f"/api/v1/orders/{order_id}/reviews", {"restaurant": 5}, format="json")
    assert w.coins_of(w.me) == 65
    review_id = Review.objects.get(order_id=order_id, target="restaurant").pk
    res = w.a.post(
        f"/api/v1/admin/reviews/{review_id}/moderation",
        {"action": "remove", "reason": "Not about the food"},
        format="json",
    )
    assert res.status_code == 200, res.json()
    assert w.coins_of(w.me) == 60


def test_can_require_a_written_comment_for_the_review_bonus(w: RewardsWorld) -> None:
    reward_config.update(None, {"earning": {"review": {"min_comment_length": 20}}})
    order_id = w.place_as()["id"]
    w.deliver(order_id)
    w.c.post(f"/api/v1/orders/{order_id}/reviews", {"restaurant": 5, "comment": "Nice"}, format="json")
    assert not CoinTransaction.objects.filter(source="REVIEW_REWARD").exists()


# --- redeeming ----------------------------------------------------------------------------------


def test_works_out_the_redeemable_amount_on_the_server() -> None:
    config = get_reward_config()

    def q(available: int, requested: int, food: int = 69_800) -> dict[str, Any]:
        return redemption_quote(config, available, requested, food)

    assert q(5000, 0)["max_redeemable"] == 1396  # 20% of ₹698 = ₹139.60 = 1396 coins
    assert q(500, 0)["max_redeemable"] == 500
    assert q(50, 0)["max_redeemable"] == 0  # below the 100-coin minimum
    assert (q(500, 200)["applied"], q(500, 200)["discount_paise"]) == (200, 2000)
    assert q(500, 900)["applied"] == 500
    assert q(500, 50)["applied"] == 0
    assert q(500, 200, 10_000)["applied"] == 0  # order below ₹199
    off = {**config, "coins_enabled": False}
    assert redemption_quote(off, 500, 200, 69_800)["applied"] == 0


def test_redeems_coins_on_a_cash_order_spent_at_once(w: RewardsWorld) -> None:
    w.gift(500)
    before = w.add().json()["data"]
    res = set_coins(w, 200)
    assert res.status_code == 200, res.json()
    quote = res.json()["data"]
    assert quote["coins"]["applied"] == 200
    assert quote["pricing"]["coinDiscountPaise"] == 2000
    assert quote["pricing"]["totalPaise"] == before["pricing"]["totalPaise"] - 2000

    order = w.place_as(fill=False, expectedTotalPaise=quote["pricing"]["totalPaise"])
    assert order["pricing"]["coinDiscountPaise"] == 2000
    assert (order["coins"]["redeemed"], order["coins"]["state"]) == (200, "committed")
    assert Payment.objects.get(order_id=order["id"]).amount_paise == quote["pricing"]["totalPaise"]
    b = w.balance()
    assert (b.available, b.reserved, b.total_redeemed) == (300, 0, 200)

    # Earning is measured after the coin discount: ₹678 -> 60 coins.
    w.deliver(order["id"])
    assert Order.objects.get(pk=order["id"]).coins_earned == 60
    w.reconciled()


def test_holds_coins_for_online_spends_when_paid_refunds_if_rejected(w: RewardsWorld) -> None:
    w.gift(500)
    w.add()
    set_coins(w, 300)
    order = w.place_as(method="online", fill=False)
    assert order["coins"]["state"] == "reserved"
    b = w.balance()
    assert (b.available, b.reserved) == (200, 300)

    pay = f"/api/v1/payments/orders/{order['id']}/mock"
    w.c.post(pay, {"outcome": "failure"}, format="json")  # a failed try keeps the hold
    assert w.balance().reserved == 300
    w.c.post(pay, {"outcome": "success"}, format="json")
    b = w.balance()
    assert (b.available, b.reserved, b.total_redeemed) == (200, 0, 300)
    assert Order.objects.get(pk=order["id"]).coins_state == "committed"

    w.reject(order["id"])
    b = w.balance()
    assert (b.available, b.total_redeemed) == (500, 0)
    assert Order.objects.get(pk=order["id"]).coins_state == "refunded"
    assert Notification.objects.filter(user_id=w.me, type="coins.returned").count() == 1
    w.reconciled()


def test_releases_held_coins_when_the_payment_window_expires(w: RewardsWorld) -> None:
    w.gift(500)
    w.add()
    set_coins(w, 150)
    order = w.place_as(method="online", fill=False)
    sweep(timezone.now() + timedelta(minutes=DISPATCH["payment_window_minutes"] + 1))
    b = w.balance()
    assert (b.available, b.reserved) == (500, 0)
    assert Order.objects.get(pk=order["id"]).coins_state == "released"
    w.reconciled()


def test_gives_coins_back_and_asks_again_when_the_payment_page_is_abandoned(
    w: RewardsWorld,
) -> None:
    w.gift(500)
    w.add()
    set_coins(w, 150)
    order = w.place_as(method="online", fill=False)
    assert w.c.post(f"/api/v1/payments/orders/{order['id']}/abandon").status_code == 200
    assert w.coins_of(w.me) == 500
    assert w.c.get("/api/v1/cart").json()["data"]["coins"]["applied"] == 150


def test_validates_the_amount_and_the_payment_method(w: RewardsWorld) -> None:
    w.gift(500)
    w.add()
    small = set_coins(w, 50)
    assert small.status_code == 422
    assert small.json()["error"]["code"] == "COINS_BELOW_MINIMUM"
    assert set_coins(w, -5).status_code == 422
    assert set_coins(w, "lots").status_code == 422
    assert set_coins(w, 5000).json()["data"]["coins"]["applied"] == 500  # clamped

    reward_config.update(None, {"redemption": {"payment_methods": ["online"]}})
    res = w.place_as(fill=False, expect=409)
    assert res["error"]["code"] == "COINS_NOT_ALLOWED"
    assert not Order.objects.exists()
    assert w.coins_of(w.me) == 500  # nothing held after a refused order


def test_refuses_an_order_when_the_balance_dropped_after_the_quote(w: RewardsWorld) -> None:
    w.gift(500, "gift-a")
    w.add()
    quote = set_coins(w, 400).json()["data"]
    wallet.reverse_credit(w.me, credit_key="gift-a", coins=300, key="rev:test")
    res = w.place_as(fill=False, expect=409, expectedTotalPaise=quote["pricing"]["totalPaise"])
    assert res["error"]["code"] == "PRICE_CHANGED"
    assert w.coins_of(w.me) == 200


def test_cannot_redeem_below_the_minimum_balance_and_shows_why(w: RewardsWorld) -> None:
    w.gift(60)
    w.add()
    assert set_coins(w, 60).status_code == 422
    coins = w.c.get("/api/v1/cart").json()["data"]["coins"]
    assert coins["maxRedeemable"] == 0
    assert "at least 100 coins" in coins["message"]


def test_removes_coins_from_the_cart(w: RewardsWorld) -> None:
    w.gift(500)
    w.add()
    set_coins(w, 200)
    data = w.c.delete("/api/v1/cart/coins").json()["data"]
    assert (data["coins"]["applied"], data["pricing"]["coinDiscountPaise"]) == (0, 0)


# --- wallet API and security --------------------------------------------------------------------


def test_shows_the_customers_own_wallet_and_history(w: RewardsWorld) -> None:
    w.gift(250)
    data = w.c.get("/api/v1/coins/wallet").json()["data"]
    assert (data["wallet"]["available"], data["wallet"]["valuePaise"]) == (250, 2500)
    assert data["rules"]["minCoins"] == 100
    assert data["rules"]["expiry"]["days"]["ORDER_REWARD"] == 180
    assert set(data["wallet"]["expiring"]) == {"enabled", "withinDays", "coins", "next", "upcoming"}
    items = w.c.get("/api/v1/coins/transactions?type=CREDIT").json()["data"]["items"]
    assert len(items) == 1
    assert items[0]["availableChange"] == 250
    assert "expiresAt" in items[0]
    assert w.c.get("/api/v1/coins/transactions?type=GIFT").status_code == 422


def test_has_no_way_for_a_client_to_change_a_balance(w: RewardsWorld) -> None:
    w.gift(10)
    for method, url in [
        ("post", "/api/v1/coins/wallet"),
        ("put", "/api/v1/coins/wallet"),
        ("patch", "/api/v1/coins/wallet"),
        ("post", "/api/v1/coins/transactions"),
    ]:
        res = getattr(w.c, method)(url, {"available": 99_999}, format="json")
        assert res.status_code == 405, f"{method} {url}"  # Node answers 404: no such route
    assert not CoinWallet.objects.filter(available=99_999).exists()


def test_keeps_wallets_to_customers(w: RewardsWorld) -> None:
    for who in (w.a, w.o, w.r):
        assert who.get("/api/v1/coins/wallet").status_code == 403
    assert APIClient().get("/api/v1/coins/wallet").status_code == 401


# --- rewards sweep ------------------------------------------------------------------------------


def test_settles_coin_holds_the_workflow_left_open_and_expires_coins(w: RewardsWorld) -> None:
    w.gift(500)
    w.add()
    set_coins(w, 100)
    order = w.place_as(method="online", fill=False)
    # A crash after the cancellation but before the coin follow-up ran.
    Order.objects.filter(pk=order["id"]).update(status="cancelled")
    summary = rewards_sweep(timezone.now())
    assert summary["coin_holds"]["returned"] == 1
    assert w.coins_of(w.me) == 500

    later = rewards_sweep(timezone.now() + timedelta(days=200))
    assert later["expired_coins"]["coins"] == 500
    assert w.coins_of(w.me) == 0
    w.reconciled()


def test_a_rewards_failure_never_fails_the_order(w: RewardsWorld, monkeypatch: Any) -> None:
    def broken(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("rewards are down")

    monkeypatch.setattr(coin_orders, "reward_delivered_order", broken)
    order = w.place_as()
    w.deliver(order["id"])  # still delivered
    assert not CoinTransaction.objects.filter(source="ORDER_REWARD").exists()
    assert client_for(w.customer["token"]).get("/api/v1/coins/wallet").status_code == 200
