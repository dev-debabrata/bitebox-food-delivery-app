"""How a delivered order's money splits (Node: config/earnings.js, services/earnings.service.js)."""

import math
from typing import Any

from apps.cart.pricing import js_round

EARNINGS = {
    "restaurant_commission_basis_points": 1500,  # 15% of the food value after the coupon
    "rider_base_paise": 2000,  # ₹20 per delivery
    "rider_per_km_paise": 600,  # ₹6 per started km (straight line)
}


def settlement_for(order: Any) -> dict[str, int]:
    food = order.subtotal_paise - (order.discount_paise or 0)
    restaurant = js_round(food * (10_000 - EARNINGS["restaurant_commission_basis_points"]) / 10_000)
    rider = (
        EARNINGS["rider_base_paise"]
        + math.ceil((order.distance_m or 0) / 1000) * EARNINGS["rider_per_km_paise"]
    )
    return {
        "restaurant_paise": restaurant,
        "rider_paise": rider,
        "platform_paise": order.total_paise - restaurant - rider,
    }
