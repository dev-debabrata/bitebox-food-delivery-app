"""
Read-only coin rules for the cart quote (Node: coins.service.js redemptionQuote/assertRedeemable,
reward-config.service.js, coin-wallet.service.js spendableCoins). Earning, reserving and spending
coins (the ledger) arrive in Phase 9.
"""

import copy
from typing import Any

from django.utils import timezone

from common.api import ApiError

from .models import EARN_SOURCES, CoinBatch, RewardConfiguration

DEFAULT_REWARD_CONFIG: dict[str, Any] = {
    "coins_enabled": True,
    "earning": {
        "order": {
            "enabled": True,
            "coins_per_unit": 10,
            "unit_paise": 10_000,
            "min_order_paise": 0,
            "max_coins_per_order": 500,
        },
        "review": {"enabled": True, "coins": 5, "min_comment_length": 0},
    },
    "redemption": {
        "enabled": True,
        "coin_value_coins": 100,  # 100 coins are worth ₹10
        "coin_value_paise": 1000,
        "min_coins": 100,
        "max_coins_per_order": 2000,
        "max_percent_of_order": 20,  # of the food value after the coupon
        "min_order_paise": 19_900,
        "payment_methods": ["cod", "online"],
    },
    "expiry": {
        "enabled": True,
        "days": {s.value: 180 for s in EARN_SOURCES},
        "restore_grace_days": 7,
        "expiring_soon_days": 30,
    },
    "referral": {
        "enabled": True,
        "referrer_coins": 50,
        "referred_coins": 25,
        "min_order_paise": 19_900,
        "attribution_days": 30,
        "max_referrals_per_customer": 50,
        "max_rewards_per_month": 10,
    },
    "birthday": {"enabled": True, "coins": 100},
    "welcome": {"enabled": True, "coins": 25, "trigger": "registration"},
}


def _merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        out[key] = (
            _merge(out[key], value)
            if isinstance(value, dict) and isinstance(out.get(key), dict)
            else value
        )
    return out


def get_reward_config() -> dict[str, Any]:
    """Defaults merged with the saved settings row (if any)."""
    row = RewardConfiguration.objects.filter(key="global").first()
    config = _merge(DEFAULT_REWARD_CONFIG, row.value if row else {})
    if row is not None:
        config["coins_enabled"] = row.coins_enabled
        config["timezone"] = row.timezone
    return config


def rule_on(config: dict[str, Any], rule: dict[str, Any]) -> bool:
    return bool(config["coins_enabled"] and rule["enabled"])


def coins_to_paise(coins: int, config: dict[str, Any]) -> int:
    r = config["redemption"]
    return (coins * r["coin_value_paise"]) // r["coin_value_coins"]


def rupees(paise: int) -> str:
    text = f"{paise / 100:.2f}"
    return f"₹{text[:-3] if text.endswith('.00') else text}"


def spendable_coins(user_id: Any, config: dict[str, Any]) -> int:
    batches = CoinBatch.objects.filter(wallet__user_id=user_id, remaining__gt=0)
    if config["expiry"]["enabled"]:
        now = timezone.now()
        batches = batches.exclude(expires_at__lte=now)
    return sum(batches.values_list("remaining", flat=True))


def load_cart_coins(user_id: Any) -> dict[str, Any]:
    config = get_reward_config()
    on = rule_on(config, config["redemption"])
    return {"config": config, "available": spendable_coins(user_id, config) if on else 0}


def redemption_quote(
    config: dict[str, Any], available: int, requested: int, food_paise: int
) -> dict[str, Any]:
    r = config["redemption"]
    base: dict[str, Any] = {
        "enabled": rule_on(config, r),
        "available": available,
        "requested": requested,
        "applied": 0,
        "discount_paise": 0,
        "max_redeemable": 0,
        "min_coins": r["min_coins"],
        "coin_value_coins": r["coin_value_coins"],
        "coin_value_paise": r["coin_value_paise"],
        "payment_methods": list(r["payment_methods"]),
        "message": None,
    }
    if not base["enabled"]:
        return {**base, "message": "Coins can't be used right now" if requested else None}
    if food_paise < r["min_order_paise"]:
        return {
            **base,
            "message": f"Coins can be used on orders of {rupees(r['min_order_paise'])} or more",
        }
    cap_paise = (food_paise * r["max_percent_of_order"]) // 100
    by_percent = (cap_paise * r["coin_value_coins"]) // r["coin_value_paise"]
    max_redeemable = max(0, min(available, r["max_coins_per_order"], by_percent))
    quote = {**base, "max_redeemable": max_redeemable}
    if max_redeemable < r["min_coins"]:
        return {
            **quote,
            "max_redeemable": 0,
            "message": f"You need at least {r['min_coins']} coins to redeem"
            if available < r["min_coins"]
            else f"Add more to your order to use at least {r['min_coins']} coins",
        }
    if not requested:
        return quote
    if requested < r["min_coins"]:
        return {**quote, "message": f"Redeem at least {r['min_coins']} coins"}
    applied = min(requested, max_redeemable)
    return {
        **quote,
        "applied": applied,
        "discount_paise": coins_to_paise(applied, config),
        "message": f"Up to {max_redeemable} coins can be used on this order"
        if applied < requested
        else None,
    }


def assert_redeemable(quote: dict[str, Any], coins: int) -> None:
    if not quote["enabled"]:
        raise ApiError(422, "Coins can't be used right now", code="COINS_UNAVAILABLE")
    if quote["max_redeemable"] == 0:
        raise ApiError(
            422,
            quote["message"] or "Coins can't be used on this order",
            code="COINS_NOT_REDEEMABLE",
        )
    if coins < quote["min_coins"]:
        raise ApiError(
            422, f"Redeem at least {quote['min_coins']} coins", code="COINS_BELOW_MINIMUM"
        )
