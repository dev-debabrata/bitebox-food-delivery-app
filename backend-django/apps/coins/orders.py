"""
Coins at checkout and the coins customers earn from orders and reviews (Node:
services/coins.service.js). Ledger mechanics live in wallet.py; this module decides *when* and
*how many*.

Order coin lifecycle (`Order.coins_state`):
    placed -> reserved (online, until paid) | committed (cash on delivery)
    paid online            -> committed
    rejected / cancelled   -> released (was reserved) | refunded (was committed)
"""

import logging
from typing import Any

from django.db.models import Q

from apps.notifications.services import notify
from apps.orders.models import CoinState, Order, OrderStatus, PaymentStatus

from . import wallet
from .quote import get_reward_config, rule_on

logger = logging.getLogger("bitebox.coins")

CS = CoinState
FINAL = (OrderStatus.DELIVERED, OrderStatus.REJECTED, OrderStatus.CANCELLED)
CLOSED = (OrderStatus.REJECTED, OrderStatus.CANCELLED)


def reserve_key(order_id: Any) -> str:
    return f"coins:reserve:{order_id}"


def order_reward_key(order_id: Any) -> str:
    return f"order-reward:{order_id}"


def review_reward_key(order_id: Any) -> str:
    return f"review-reward:{order_id}"


def food_value_paise(order: Any) -> int:
    """The food value rewards and redemption caps are measured on: subtotal after the coupon."""
    return int(order.subtotal_paise - (order.discount_paise or 0))


def customer_rules(config: dict[str, Any]) -> dict[str, Any]:
    """Redemption rules the customer may see (checkout, wallet page)."""
    r = config["redemption"]
    earning = config["earning"]["order"]
    return {
        "enabled": rule_on(config, r),
        "earning_enabled": rule_on(config, earning),
        "coin_value_coins": r["coin_value_coins"],
        "coin_value_paise": r["coin_value_paise"],
        "min_coins": r["min_coins"],
        "max_coins_per_order": r["max_coins_per_order"],
        "max_percent_of_order": r["max_percent_of_order"],
        "min_order_paise": r["min_order_paise"],
        "payment_methods": list(r["payment_methods"]),
        "order": {
            "coins_per_unit": earning["coins_per_unit"],
            "unit_paise": earning["unit_paise"],
            "min_order_paise": earning["min_order_paise"],
            "max_coins_per_order": earning["max_coins_per_order"],
        },
        "review_coins": (
            config["earning"]["review"]["coins"]
            if rule_on(config, config["earning"]["review"])
            else 0
        ),
        "expiry": {"enabled": config["expiry"]["enabled"], "days": dict(config["expiry"]["days"])},
    }


# ---------------------------------------------------------------------------
# Order hooks
# ---------------------------------------------------------------------------
def reserve_for_order(order: Order, *, cash: bool) -> None:
    """Inside order placement: holds the coins. Cash orders spend them at once."""
    coins = order.coins_redeemed or 0
    if not coins:
        return
    key = reserve_key(order.pk)
    wallet.reserve(
        order.customer_id,
        coins=coins,
        key=key,
        order_id=order.pk,
        description=f"{coins} coins used on order {order.order_number}",
    )
    if cash:
        wallet.commit_reservation(
            order.customer_id,
            reserve_key=key,
            description=f"{coins} coins redeemed on order {order.order_number}",
        )


def commit_for_order(order: Order) -> None:
    """An online order was paid: spend its reserved coins. Safe to repeat."""
    if order.coins_state != CS.RESERVED:
        return
    wallet.commit_reservation(
        order.customer_id,
        reserve_key=reserve_key(order.pk),
        description=f"{order.coins_redeemed} coins redeemed on order {order.order_number}",
    )
    Order.objects.filter(pk=order.pk, coins_state=CS.RESERVED).update(coins_state=CS.COMMITTED)
    order.coins_state = CS.COMMITTED


def return_for_order(order: Order) -> None:
    """The order was rejected or cancelled: give the coins back. Safe to repeat."""
    state = order.coins_state
    if state not in (CS.RESERVED, CS.COMMITTED):
        return
    key = reserve_key(order.pk)
    coins = order.coins_redeemed

    def refund() -> None:
        wallet.refund_redemption(
            order.customer_id,
            reserve_key=key,
            description=f"{coins} coins refunded: order {order.order_number} {order.status}",
        )
        Order.objects.filter(pk=order.pk, coins_state__in=[CS.RESERVED, CS.COMMITTED]).update(
            coins_state=CS.REFUNDED
        )
        order.coins_state = CS.REFUNDED

    if state == CS.COMMITTED:
        refund()
    else:
        try:
            wallet.release_reservation(
                order.customer_id,
                reserve_key=key,
                description=f"{coins} coins returned: order {order.order_number} {order.status}",
            )
            Order.objects.filter(pk=order.pk, coins_state=CS.RESERVED).update(
                coins_state=CS.RELEASED
            )
            order.coins_state = CS.RELEASED
        except Exception as error:
            # Paid (so spent) at the same moment: refund the spent coins instead.
            if getattr(error, "code", None) != "RESERVATION_CLOSED":
                raise
            refund()
    notify(
        order.customer_id,
        type="coins.returned",
        title=f"{coins} coins are back in your wallet",
        body=f"Order {order.order_number} was {order.status}",
        link="/account/coins",
        order=order,
    )


def order_reward_coins(order: Any, config: dict[str, Any]) -> int:
    """floor(food value after discounts / unit) × coins per unit, capped."""
    rule = config["earning"]["order"]
    if not rule_on(config, rule):
        return 0
    base = food_value_paise(order) - (order.coin_discount_paise or 0)
    if base <= 0 or base < rule["min_order_paise"]:
        return 0
    coins = (base // rule["unit_paise"]) * rule["coins_per_unit"]
    return int(min(coins, rule["max_coins_per_order"]))


def reward_delivered_order(order: Order) -> Any:
    """Delivered: credit the order reward once."""
    if order.status != OrderStatus.DELIVERED:
        return None
    coins = order_reward_coins(order, get_reward_config())
    if not coins:
        return None
    result = wallet.credit(
        order.customer_id,
        coins=coins,
        source="ORDER_REWARD",
        key=order_reward_key(order.pk),
        order_id=order.pk,
        description=f"Reward for order {order.order_number}",
    )
    Order.objects.filter(pk=order.pk).update(coins_earned=result.row().coins)
    if result.created:
        notify(
            order.customer_id,
            type="coins.earned",
            title=f"You earned {coins} coins",
            body=f"Reward for order {order.order_number}",
            link="/account/coins",
            order=order,
        )
    return result.txn


def reward_review(order: Order, review: Any) -> Any:
    """A restaurant review was posted for a delivered order: the review bonus, once per order."""
    config = get_reward_config()
    rule = config["earning"]["review"]
    if not rule_on(config, rule) or not rule["coins"]:
        return None
    if order.status != OrderStatus.DELIVERED:
        return None
    if len((getattr(review, "comment", "") or "").strip()) < rule["min_comment_length"]:
        return None
    result = wallet.credit(
        order.customer_id,
        coins=rule["coins"],
        source="REVIEW_REWARD",
        key=review_reward_key(order.pk),
        order_id=order.pk,
        description=f"Thanks for reviewing order {order.order_number}",
    )
    if result.created:
        notify(
            order.customer_id,
            type="coins.earned",
            title=f"You earned {rule['coins']} coins",
            body="Thanks for your review",
            link="/account/coins",
            order=order,
        )
    return result.txn


def reverse_review_reward(customer_id: Any, order_id: Any, why: str) -> Any:
    """The rewarded review was removed or deleted: take the bonus back."""
    try:
        return wallet.reverse_credit(
            customer_id,
            credit_key=review_reward_key(order_id),
            key=f"{review_reward_key(order_id)}:reversal",
            description=f"Review bonus reversed: {why}",
        ).txn
    except Exception as error:
        if getattr(error, "code", None) in ("NOT_FOUND", "ALREADY_REVERSED"):
            return None
        raise


def settle_stale_reservations(*, limit: int = 100) -> dict[str, int]:
    """Rewards sweep: orders whose coin hold the workflow did not close."""
    summary = {"committed": 0, "returned": 0}
    stale = Order.objects.filter(coins_state=CS.RESERVED).filter(
        Q(status__in=FINAL) | Q(payment_status=PaymentStatus.PAID)
    )[:limit]
    for order in stale:
        try:
            if order.status in CLOSED:
                return_for_order(order)
                summary["returned"] += 1
            else:
                commit_for_order(order)
                summary["committed"] += 1
        except Exception:
            logger.exception("Could not settle an order's coins", extra={"order_id": str(order.pk)})
    return summary
