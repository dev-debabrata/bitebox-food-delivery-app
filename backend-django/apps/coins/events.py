"""
The single place where order, review and account events reach the rewards programme (Node:
services/reward-events.js). Every step is idempotent (ledger keys, conditional updates) and
best-effort: it runs in its own savepoint, and a failure is logged and never fails the order,
payment, review or sign-up that triggered it. The rewards sweep retries what can be retried.
"""

import logging
from collections.abc import Callable
from typing import Any

from django.db import transaction

from . import orders, referrals, special

logger = logging.getLogger("bitebox.coins")


def safely(step: str, context: dict[str, str], work: Callable[[], Any]) -> Any:
    try:
        with transaction.atomic():
            return work()
    except Exception:
        logger.exception("Rewards step failed", extra={"step": step, **context})
        return None


def _ctx(order: Any) -> dict[str, str]:
    return {"order_id": str(order.pk)}


def customer_registered(
    user: Any, referral: dict[str, Any] | None = None, ip: str | None = None
) -> None:
    """A customer account was created (`referral` is what referrals.resolve_code accepted)."""
    context = {"user_id": str(user.pk)}
    safely("referral.code", context, lambda: referrals.ensure_referral_code(user.pk))
    if referral:
        safely("referral.signup", context, lambda: referrals.record_signup(user, referral, ip=ip))
    safely("welcome.registration", context, lambda: special.maybe_welcome(user.pk, "registration"))


def order_placed(order: Any) -> None:
    safely("referral.orderPlaced", _ctx(order), lambda: referrals.on_order_placed(order))


def order_paid(order: Any) -> None:
    """An online order was paid: spend the coins it held."""
    safely("coins.commit", _ctx(order), lambda: orders.commit_for_order(order))


def order_closed(order: Any) -> None:
    """The order was rejected or cancelled."""
    safely("coins.return", _ctx(order), lambda: orders.return_for_order(order))
    safely("referral.orderClosed", _ctx(order), lambda: referrals.on_order_closed(order))


def order_delivered(order: Any) -> None:
    safely("coins.orderReward", _ctx(order), lambda: orders.reward_delivered_order(order))
    safely("referral.qualify", _ctx(order), lambda: referrals.on_order_delivered(order))
    safely(
        "welcome.firstOrder",
        _ctx(order),
        lambda: special.maybe_welcome(order.customer_id, "first_order"),
    )
    safely("campaigns.order", _ctx(order), lambda: special.on_order_delivered(order))


def reviews_posted(order: Any, reviews: Any) -> None:
    """Reviews were posted for an order (the restaurant review earns the bonus)."""
    restaurant_review = next((r for r in reviews if r.target == "restaurant"), None)
    if restaurant_review is None:
        return
    safely(
        "coins.reviewReward", _ctx(order), lambda: orders.reward_review(order, restaurant_review)
    )


def review_withdrawn(review: Any, why: str) -> None:
    """A restaurant review stopped counting (removed by moderation, deleted by its author)."""
    if review.target != "restaurant":
        return
    safely(
        "coins.reviewReversal",
        {"review_id": str(review.pk)},
        lambda: orders.reverse_review_reward(review.customer_id, review.order_id, why),
    )
