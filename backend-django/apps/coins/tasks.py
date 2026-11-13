"""
Scheduled rewards work (Node: services/rewards-jobs.service.js). Every step is bounded, idempotent
and safe to run on several workers at once. Celery Beat runs it every 2 minutes; tests call
`rewards_sweep(now)` directly.
"""

import logging
from collections.abc import Callable
from datetime import datetime
from typing import Any

from celery import shared_task
from django.utils import timezone

from . import orders, referrals, special, wallet

logger = logging.getLogger("bitebox.coins")

BATCH_SIZE = 200  # records each step handles per run, so one run never runs long

STEPS: list[tuple[str, Callable[[datetime, int], Any]]] = [
    ("pending_ledger_rows", lambda now, limit: wallet.pending_rows(now=now, limit=limit)),
    ("coin_holds", lambda now, limit: orders.settle_stale_reservations(limit=limit)),
    ("expired_coins", lambda now, limit: wallet.expire_due_coins(now=now, limit=limit)),
    ("referrals", lambda now, limit: referrals.referral_sweep(now=now, limit=limit)),
    ("campaigns", lambda now, limit: special.campaign_sweep(now=now, limit=limit)),
    ("birthdays", lambda now, limit: special.birthday_sweep(now=now, limit=limit)),
]


def rewards_sweep(now: datetime | None = None, *, limit: int = BATCH_SIZE) -> dict[str, Any]:
    now = now or timezone.now()
    summary: dict[str, Any] = {}
    for name, run in STEPS:
        try:
            summary[name] = run(now, limit)
        except Exception as error:
            summary[name] = {"error": str(error)}
            logger.exception("Rewards sweep step failed", extra={"step": name})
    return summary


@shared_task(name="coins.rewards_sweep", ignore_result=True)
def rewards_sweep_task() -> None:
    """Celery Beat (every 2 minutes)."""
    rewards_sweep()
