"""
Review events for the coins programme (Node: services/reward-events.js#reviewsPosted and
#reviewWithdrawn): the restaurant review of a delivered order earns the review bonus once per
order (apps/coins/orders.py#reward_review), and loses it when the review is deleted or removed.
Both are best-effort: failures are logged and never fail the review request.
"""

from collections.abc import Iterable
from typing import Any


def reviews_posted(order: Any, reviews: Iterable[Any]) -> None:
    """A "Rate your experience" submission was saved (Node: rewardEvents.reviewsPosted)."""
    from apps.coins import events

    events.reviews_posted(order, list(reviews))


def review_withdrawn(review: Any, why: str) -> None:
    """A restaurant review stopped counting: deleted or removed (Node: reviewWithdrawn)."""
    from apps.coins import events

    events.review_withdrawn(review, why)
