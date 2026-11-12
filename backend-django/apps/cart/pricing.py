"""
Prices, fees, tax and totals (Node: config/pricing.js, services/pricing.service.js). Integer paise
throughout. These values become admin-editable settings in release 2 (orders keep a snapshot).
"""

import math
from dataclasses import asdict, dataclass
from typing import Any

PRICING = {
    # A base fee covers the first few km, then a per-km charge (whole km, rounded up), capped.
    "delivery_base_fee_paise": 2500,  # ₹25
    "delivery_base_km": 2,
    "delivery_per_km_paise": 800,  # ₹8 per extra km
    "delivery_max_fee_paise": 9900,  # ₹99
    # Orders at or above this (after the coupon) deliver free.
    "free_delivery_threshold_paise": 49900,  # ₹499
    # Restaurants deliver within this straight-line distance.
    "max_delivery_distance_km": 15,
    "platform_fee_paise": 500,  # ₹5 per order
    # GST on food, on the subtotal after the coupon, in basis points (500 = 5%).
    "food_tax_basis_points": 500,
}


def js_round(value: float) -> int:
    """JavaScript's Math.round (halves round up), not Python's round-half-to-even."""
    return math.floor(value + 0.5)


def coupon_discount(coupon: Any, subtotal_paise: int) -> int:
    """Never more than the subtotal; percentage discounts are capped by max_discount_paise."""
    if coupon is None:
        return 0
    if coupon.discount_type == "percent":
        discount = (subtotal_paise * coupon.discount_value) // 100
    else:
        discount = coupon.discount_value
    if coupon.max_discount_paise:
        discount = min(discount, coupon.max_discount_paise)
    return max(0, min(discount, subtotal_paise))


def delivery_fee(distance_m: float, discounted_subtotal_paise: int) -> int:
    if discounted_subtotal_paise >= PRICING["free_delivery_threshold_paise"]:
        return 0
    extra_km = max(0, math.ceil(distance_m / 1000 - PRICING["delivery_base_km"]))
    return min(
        PRICING["delivery_base_fee_paise"] + extra_km * PRICING["delivery_per_km_paise"],
        PRICING["delivery_max_fee_paise"],
    )


@dataclass(frozen=True)
class Pricing:
    subtotal_paise: int
    discount_paise: int
    delivery_fee_paise: int
    platform_fee_paise: int
    tax_paise: int
    coin_discount_paise: int
    total_paise: int

    def as_dict(self) -> dict[str, int]:
        return asdict(self)


def compute_pricing(
    subtotal_paise: int,
    coupon: Any = None,
    distance_m: float | None = None,
    coin_discount_paise: int = 0,
) -> Pricing:
    discount = coupon_discount(coupon, subtotal_paise)
    discounted = subtotal_paise - discount
    fee = 0 if distance_m is None else delivery_fee(distance_m, discounted)
    tax = js_round(discounted * PRICING["food_tax_basis_points"] / 10_000)
    platform = PRICING["platform_fee_paise"] if subtotal_paise > 0 else 0
    before_coins = discounted + fee + platform + tax
    # Coins pay part of the bill; they never change tax, fees or the free-delivery threshold.
    coins = max(0, min(coin_discount_paise, before_coins))
    return Pricing(subtotal_paise, discount, fee, platform, tax, coins, before_coins - coins)
