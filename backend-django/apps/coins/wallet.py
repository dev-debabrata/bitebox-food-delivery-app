"""
The coin wallet and its ledger (Node: services/coin-wallet.service.js). Only this module changes
wallets. Every change is one immutable CoinTransaction row, written in the same database
transaction as the wallet balances and the batches it draws from or gives back to:

    1. lock the wallet row (select_for_update), so operations on one wallet run one at a time;
    2. a repeated idempotency key returns the row it created before (`created=False`);
    3. plan the row (balance checks, FIFO allocations), then write the row (posted), its
       allocations, the batches and the wallet.

Rows are written posted straight away (Node's pending → posted recovery is not needed: the
transaction either commits everything or nothing). Callers check whether coins are enabled; the
ledger itself always works, so staff can still correct balances when the programme is off.

Coins handed back (a released hold, a refunded redemption) return to the batches they came from,
with at least the grace period left before they expire.
"""

import logging
import math
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from django.db import transaction
from django.db.models import Q, QuerySet
from django.utils import timezone

from common.api import ApiError
from common.pagination import Page, paginate

from .config import expiry_for, restored_expiry
from .models import (
    EARN_SOURCES,
    MAX_COINS_PER_OPERATION,
    CoinAllocation,
    CoinBatch,
    CoinSource,
    CoinTransaction,
    CoinWallet,
    LedgerStatus,
    ReversalOf,
    TxnType,
)
from .quote import coins_to_paise, get_reward_config

logger = logging.getLogger("bitebox.coins")

T = TxnType
S = CoinSource
COUNTERS = (
    "available",
    "reserved",
    "total_earned",
    "total_redeemed",
    "total_expired",
    "total_reversed",
    "uncollected_reversal",
)


class _Default:
    """`expires_at` not given: use the source's configured expiry."""


DEFAULT = _Default()


@dataclass
class Result:
    txn: CoinTransaction | None
    created: bool

    def row(self) -> CoinTransaction:
        """The ledger row of an operation that always writes (or finds) one."""
        if self.txn is None:
            raise RuntimeError("The wallet operation wrote no ledger row")
        return self.txn


@dataclass
class Plan:
    """One ledger row to write. `take`: coins consumed per batch; `give`: coins handed back."""

    type: str
    source: str
    coins: int
    description: str
    take: list[tuple[CoinBatch, int]] = field(default_factory=list)
    give: list[tuple[CoinBatch, int, datetime | None]] = field(default_factory=list)
    fields: dict[str, Any] = field(default_factory=dict)


def _assert_coins(coins: Any) -> None:
    if (
        isinstance(coins, bool)
        or not isinstance(coins, int)
        or coins < 1
        or coins > MAX_COINS_PER_OPERATION
    ):
        message = "Coins must be a positive whole number"
        raise ApiError(
            422, message, code="VALIDATION_ERROR", details=[{"field": "coins", "message": message}]
        )


def _overdue(batch: CoinBatch, now: datetime) -> bool:
    return batch.expires_at is not None and batch.expires_at <= now


def _fifo_key(batch: CoinBatch) -> tuple[float, datetime, str]:
    """Earliest expiry first (never-expiring last), then oldest first."""
    expires = batch.expires_at.timestamp() if batch.expires_at else math.inf
    return (expires, batch.earned_at, str(batch.pk))


def _live_batches(wallet: CoinWallet) -> list[CoinBatch]:
    return list(CoinBatch.objects.filter(wallet=wallet, remaining__gt=0))


def _take_fifo(
    batches: list[CoinBatch],
    coins: int,
    now: datetime,
    *,
    include_overdue: bool = False,
    prefer_origin: Any = None,
) -> tuple[list[tuple[CoinBatch, int]], int]:
    """Up to `coins` from the batches, FIFO; `prefer_origin` drains that credit's batch first."""
    candidates = sorted(
        (b for b in batches if b.remaining > 0 and (include_overdue or not _overdue(b, now))),
        key=lambda b: (0 if prefer_origin and b.origin_id == prefer_origin else 1, *_fifo_key(b)),
    )
    taken: list[tuple[CoinBatch, int]] = []
    left = coins
    for batch in candidates:
        if left == 0:
            break
        n = min(batch.remaining, left)
        taken.append((batch, n))
        left -= n
    return taken, coins - left


def _spendable(batches: list[CoinBatch], now: datetime, expiry_enabled: bool) -> int:
    return sum(b.remaining for b in batches if not expiry_enabled or not _overdue(b, now))


def _key_owner_check(existing: CoinTransaction, user_id: Any) -> Result:
    if str(existing.user_id) != str(user_id):
        raise RuntimeError(f"Idempotency key {existing.idempotency_key} belongs to another wallet")
    return Result(existing, False)


def _execute(
    user_id: Any,
    key: str,
    plan: Callable[[CoinWallet, datetime], Plan | None],
    now: datetime | None = None,
) -> Result:
    if not key or not isinstance(key, str):
        raise RuntimeError("A wallet operation needs an idempotency key")
    now = now or timezone.now()
    with transaction.atomic():
        existing = CoinTransaction.objects.filter(idempotency_key=key).first()
        if existing is not None:
            return _key_owner_check(existing, user_id)
        CoinWallet.objects.get_or_create(user_id=user_id)
        wallet = CoinWallet.objects.select_for_update().get(user_id=user_id)
        # Someone holding the lock before us may have written this very key.
        existing = CoinTransaction.objects.filter(idempotency_key=key).first()
        if existing is not None:
            return _key_owner_check(existing, user_id)
        planned = plan(wallet, now)
        if planned is None:
            return Result(None, False)
        return Result(_write(wallet, key, planned, now), True)


def _write(wallet: CoinWallet, key: str, plan: Plan, now: datetime) -> CoinTransaction:
    c = plan.coins
    before_available, before_reserved = wallet.available, wallet.reserved
    reversal_of = plan.fields.get("reversal_of")
    if plan.type == T.CREDIT:
        wallet.available += c
        wallet.total_earned += c
    elif plan.type == T.RESERVE:
        wallet.available -= c
        wallet.reserved += c
    elif plan.type == T.DEBIT:
        wallet.reserved -= c
        wallet.total_redeemed += c
    elif plan.type == T.RELEASE:
        wallet.reserved -= c
        wallet.available += c
    elif plan.type == T.EXPIRE:
        wallet.available -= c
        wallet.total_expired += c
    elif plan.type == T.REVERSAL and reversal_of == ReversalOf.CREDIT:
        wallet.available -= c
        wallet.total_reversed += c
        wallet.uncollected_reversal += plan.fields.get("shortfall") or 0
    elif plan.type == T.REVERSAL:
        wallet.available += c
        wallet.total_redeemed -= c
    else:
        raise RuntimeError(f"Unknown ledger row type {plan.type}")
    moved = sum(n for _, n in plan.take) + sum(n for _, n, _ in plan.give)
    if plan.type in (T.RESERVE, T.RELEASE, T.EXPIRE, T.REVERSAL) and moved != c:
        raise RuntimeError(f"Ledger row {key}: allocations ({moved}) do not match {c} coins")
    if any(getattr(wallet, f) < 0 for f in COUNTERS):
        raise RuntimeError(f"Ledger row {key} would make the wallet negative")

    wallet.seq += 1
    txn = CoinTransaction.objects.create(
        user_id=wallet.user_id,
        wallet=wallet,
        seq=wallet.seq,
        type=plan.type,
        source=plan.source,
        coins=c,
        available_before=before_available,
        available_after=wallet.available,
        reserved_before=before_reserved,
        reserved_after=wallet.reserved,
        idempotency_key=key,
        description=plan.description[:300],
        status=LedgerStatus.POSTED,
        posted_at=now,
        **plan.fields,
    )
    for batch, n in plan.take:
        batch.remaining -= n
        batch.save(update_fields=["remaining", "updated_at"])
        CoinAllocation.objects.create(
            transaction=txn,
            batch=batch,
            source=batch.source,
            earned_at=batch.earned_at,
            expires_at=batch.expires_at,
            coins=n,
        )
    for batch, n, expires_at in plan.give:
        batch.remaining += n
        batch.expires_at = expires_at
        batch.save(update_fields=["remaining", "expires_at", "updated_at"])
        CoinAllocation.objects.create(
            transaction=txn,
            batch=batch,
            source=batch.source,
            earned_at=batch.earned_at,
            expires_at=expires_at,
            coins=n,
        )
    if plan.type == T.CREDIT:
        CoinBatch.objects.create(
            wallet=wallet,
            origin=txn,
            source=plan.source,
            original=c,
            remaining=c,
            earned_at=now,
            expires_at=plan.fields.get("expires_at"),
        )
    wallet.save()
    return txn


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------
def credit(
    user_id: Any,
    *,
    coins: int,
    source: str,
    key: str,
    description: str | None = None,
    order_id: Any = None,
    campaign_id: Any = None,
    referral_id: Any = None,
    created_by_id: Any = None,
    note: str = "",
    expires_at: datetime | _Default | None = DEFAULT,
    now: datetime | None = None,
) -> Result:
    """Adds earned coins as a new batch. `expires_at` defaults to the source's configured expiry."""
    _assert_coins(coins)
    if source not in [s.value for s in EARN_SOURCES]:
        raise RuntimeError(f"{source} is not an earning source")
    now = now or timezone.now()
    expiry = (
        expiry_for(source, get_reward_config(), now)
        if isinstance(expires_at, _Default)
        else expires_at
    )
    return _execute(
        user_id,
        key,
        lambda _wallet, _now: Plan(
            T.CREDIT,
            source,
            coins,
            description or f"{coins} coins earned",
            fields={
                "expires_at": expiry,
                "order_id": order_id,
                "campaign_id": campaign_id,
                "referral_id": referral_id,
                "created_by_id": created_by_id,
                "note": note or "",
            },
        ),
        now,
    )


def reserve(
    user_id: Any,
    *,
    coins: int,
    key: str,
    order_id: Any = None,
    description: str | None = None,
    now: datetime | None = None,
) -> Result:
    """Holds coins for an order (checkout). 409 INSUFFICIENT_COINS when they are not there."""
    _assert_coins(coins)
    config = get_reward_config()
    expiry_on = config["expiry"]["enabled"]

    def plan(wallet: CoinWallet, now: datetime) -> Plan:
        batches = _live_batches(wallet)
        take, taken = _take_fifo(batches, coins, now, include_overdue=not expiry_on)
        if taken < coins:
            raise ApiError.conflict(
                f"You have only {_spendable(batches, now, expiry_on)} coins available",
                "INSUFFICIENT_COINS",
            )
        return Plan(
            T.RESERVE,
            S.COIN_REDEMPTION,
            coins,
            description or f"{coins} coins held for your order",
            take=take,
            fields={"order_id": order_id},
        )

    return _execute(user_id, key, plan, now)


def _reservation(user_id: Any, reserve_key: str) -> tuple[CoinTransaction, Any, Any]:
    reservation = CoinTransaction.objects.filter(
        idempotency_key=reserve_key, user_id=user_id, type=T.RESERVE
    ).first()
    if reservation is None:
        raise ApiError.not_found("Coin reservation not found")
    closing = list(
        CoinTransaction.objects.filter(related_txn=reservation, type__in=[T.DEBIT, T.RELEASE])
    )
    debit = next((r for r in closing if r.type == T.DEBIT), None)
    release = next((r for r in closing if r.type == T.RELEASE), None)
    return reservation, debit, release


def _given_back(
    reservation: CoinTransaction, config: dict[str, Any], now: datetime
) -> list[tuple[CoinBatch, int, datetime | None]]:
    """The reservation's coins, back to the batches they came from, with the grace period."""
    out: list[tuple[CoinBatch, int, datetime | None]] = []
    for a in reservation.allocations.select_related("batch").order_by("pk"):
        batch = CoinBatch.objects.get(pk=a.batch_id)  # fresh: earlier rows may have moved it
        latest = max(filter(None, [a.expires_at, batch.expires_at]), default=None)
        expires = restored_expiry(latest, config, now) if config["expiry"]["enabled"] else latest
        out.append((batch, a.coins, expires))
    return out


def commit_reservation(user_id: Any, *, reserve_key: str, description: str | None = None) -> Result:
    """Spends a reservation (the order was paid or placed with cash). Exactly once."""

    def plan(_wallet: CoinWallet, _now: datetime) -> Plan:
        reservation, _debit, release = _reservation(user_id, reserve_key)
        if release is not None:
            raise ApiError.conflict("These coins were already released", "RESERVATION_CLOSED")
        return Plan(
            T.DEBIT,
            S.COIN_REDEMPTION,
            reservation.coins,
            description or f"{reservation.coins} coins redeemed",
            fields={"related_txn": reservation, "order_id": reservation.order_id},
        )

    return _execute(user_id, f"{reserve_key}:commit", plan)


def release_reservation(
    user_id: Any, *, reserve_key: str, description: str | None = None, now: datetime | None = None
) -> Result:
    """Gives a reservation back (payment never completed, order closed). Exactly once."""
    config = get_reward_config()

    def plan(_wallet: CoinWallet, now: datetime) -> Plan:
        reservation, debit, _release = _reservation(user_id, reserve_key)
        if debit is not None:
            raise ApiError.conflict("These coins were already redeemed", "RESERVATION_CLOSED")
        return Plan(
            T.RELEASE,
            S.COIN_REDEMPTION,
            reservation.coins,
            description or f"{reservation.coins} coins returned to your wallet",
            give=_given_back(reservation, config, now),
            fields={"related_txn": reservation, "order_id": reservation.order_id},
        )

    return _execute(user_id, f"{reserve_key}:release", plan, now)


def refund_redemption(
    user_id: Any, *, reserve_key: str, description: str | None = None, now: datetime | None = None
) -> Result:
    """Gives back coins that were spent on an order that was then cancelled. Exactly once."""
    config = get_reward_config()

    def plan(_wallet: CoinWallet, now: datetime) -> Plan:
        reservation, debit, _release = _reservation(user_id, reserve_key)
        if debit is None:
            raise ApiError.conflict("These coins were not redeemed", "NOT_REDEEMED")
        return Plan(
            T.REVERSAL,
            S.COIN_REDEMPTION,
            debit.coins,
            description or f"{debit.coins} redeemed coins refunded",
            give=_given_back(reservation, config, now),
            fields={
                "reversal_of": ReversalOf.REDEMPTION,
                "related_txn": debit,
                "order_id": reservation.order_id,
            },
        )

    return _execute(user_id, f"{reserve_key}:refund", plan, now)


def reverse_credit(
    user_id: Any,
    *,
    credit_key: str,
    key: str,
    coins: int | None = None,
    description: str | None = None,
    note: str = "",
    created_by_id: Any = None,
    now: datetime | None = None,
) -> Result:
    """
    Claws back coins from an earned credit (refund of a rewarded order, fraud). `coins` defaults
    to everything not yet reversed; partial reversals add up to at most the credit. Coins come from
    that credit's batch first, then FIFO; coins already spent become a shortfall instead of a
    negative balance. Each reversal needs its own `key`.
    """
    if coins is not None:
        _assert_coins(coins)

    def plan(wallet: CoinWallet, now: datetime) -> Plan:
        original = CoinTransaction.objects.filter(
            idempotency_key=credit_key, user_id=user_id, type=T.CREDIT
        ).first()
        if original is None:
            raise ApiError.not_found("Reward not found")
        previous = CoinTransaction.objects.filter(
            related_txn=original, type=T.REVERSAL, reversal_of=ReversalOf.CREDIT
        )
        reversible = original.coins - sum(
            (r.requested_coins if r.requested_coins is not None else r.coins) for r in previous
        )
        requested = coins if coins is not None else reversible
        if reversible <= 0:
            raise ApiError.conflict("This reward was already reversed", "ALREADY_REVERSED")
        if requested > reversible:
            raise ApiError.conflict(
                f"Only {reversible} coins of this reward can still be reversed",
                "REVERSAL_TOO_LARGE",
            )
        take, taken = _take_fifo(
            _live_batches(wallet), requested, now, include_overdue=True, prefer_origin=original.pk
        )
        return Plan(
            T.REVERSAL,
            S.REWARD_REVERSAL,
            taken,
            description or f"{requested} reward coins reversed",
            take=take,
            fields={
                "reversal_of": ReversalOf.CREDIT,
                "requested_coins": requested,
                "shortfall": requested - taken,
                "related_txn": original,
                "order_id": original.order_id,
                "campaign_id": original.campaign_id,
                "referral_id": original.referral_id,
                "note": note or "",
                "created_by_id": created_by_id,
            },
        )

    return _execute(user_id, key, plan, now)


def _expire_batch(batch: CoinBatch, now: datetime) -> Result:
    """Expires one batch if it is past its expiry date. Idempotent per batch and expiry date."""
    if batch.expires_at is None:
        return Result(None, False)
    config = get_reward_config()
    user_id = CoinWallet.objects.values_list("user_id", flat=True).get(pk=batch.wallet_id)

    def plan(_wallet: CoinWallet, now: datetime) -> Plan | None:
        fresh = CoinBatch.objects.get(pk=batch.pk)
        if not config["expiry"]["enabled"] or fresh.remaining == 0 or not _overdue(fresh, now):
            return None
        return Plan(
            T.EXPIRE,
            S.COIN_EXPIRY,
            fresh.remaining,
            f"{fresh.remaining} coins expired",
            take=[(fresh, fresh.remaining)],
            fields={"related_txn_id": fresh.origin_id},
        )

    stamp = int(batch.expires_at.timestamp())
    return _execute(user_id, f"expire:{batch.pk}:{stamp}", plan, now)


def expire_due_coins(*, now: datetime | None = None, limit: int = 200) -> dict[str, int]:
    """Rewards sweep: expires every overdue batch (bounded per run)."""
    now = now or timezone.now()
    summary = {"wallets": 0, "batches": 0, "coins": 0}
    if not get_reward_config()["expiry"]["enabled"]:
        return summary
    due = Q(batches__expires_at__isnull=False, batches__expires_at__lte=now) & Q(
        batches__remaining__gt=0
    )
    wallets = list(CoinWallet.objects.filter(due).distinct().order_by("pk")[:limit])
    for wallet in wallets:
        summary["wallets"] += 1
        overdue = CoinBatch.objects.filter(
            wallet=wallet, remaining__gt=0, expires_at__isnull=False, expires_at__lte=now
        )
        for batch in overdue:
            try:
                result = _expire_batch(batch, now)
                if result.created and result.txn is not None:
                    summary["batches"] += 1
                    summary["coins"] += result.txn.coins
            except Exception:
                logger.exception(
                    "Coin expiry failed for a batch", extra={"wallet_id": str(wallet.pk)}
                )
    return summary


def pending_rows(*, now: datetime | None = None, limit: int = 100) -> int:
    """
    Rewards sweep (Node: settlePendingRows). Django writes rows posted inside one transaction, so
    pending rows only come from an import of Node data; they are reported, never guessed at.
    """
    now = now or timezone.now()
    stale = CoinTransaction.objects.filter(
        status=LedgerStatus.PENDING, created_at__lte=now - timedelta(seconds=60)
    )
    count = stale.values("wallet").distinct().count()
    if count:
        logger.error("Coin ledger rows left pending", extra={"wallets": count})
    return 0


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------
def wallet_summary(user_id: Any, *, now: datetime | None = None) -> dict[str, Any]:
    """The customer's wallet: balances, rupee value and upcoming expiries."""
    now = now or timezone.now()
    config = get_reward_config()
    wallet = CoinWallet.objects.filter(user_id=user_id).first()
    batches = _live_batches(wallet) if wallet else []
    expiry_on = config["expiry"]["enabled"]
    available = _spendable(batches, now, expiry_on)
    live = [b for b in batches if not expiry_on or not _overdue(b, now)]
    soon = now + timedelta(days=config["expiry"]["expiring_soon_days"])
    dated = sorted((b for b in live if b.expires_at), key=_fifo_key) if expiry_on else []
    tz = ZoneInfo(config["timezone"])
    by_day: dict[str, int] = {}
    for b in dated:
        day = b.expires_at.astimezone(tz).strftime("%Y-%m-%d") if b.expires_at else ""
        by_day[day] = by_day.get(day, 0) + b.remaining
    first = dated[0] if dated else None
    return {
        "available": available,
        "reserved": wallet.reserved if wallet else 0,
        "total_earned": wallet.total_earned if wallet else 0,
        "total_redeemed": wallet.total_redeemed if wallet else 0,
        "total_expired": wallet.total_expired if wallet else 0,
        "total_reversed": wallet.total_reversed if wallet else 0,
        "value_paise": coins_to_paise(available, config),
        "expiring": {
            "enabled": expiry_on,
            "within_days": config["expiry"]["expiring_soon_days"],
            "coins": sum(b.remaining for b in dated if b.expires_at and b.expires_at <= soon),
            "next": (
                {
                    "expires_at": first.expires_at,
                    "coins": by_day[first.expires_at.astimezone(tz).strftime("%Y-%m-%d")],
                }
                if first and first.expires_at
                else None
            ),
            "upcoming": [{"date": d, "coins": n} for d, n in list(by_day.items())[:6]],
        },
    }


def customer_txn_view(row: CoinTransaction) -> dict[str, Any]:
    """One ledger row as the customer sees it (no staff notes or internal references)."""
    data: dict[str, Any] = {
        "id": str(row.pk),
        "type": row.type,
        "source": row.source,
        "coins": row.coins,
        "available_change": row.available_after - row.available_before,
        "reserved_change": row.reserved_after - row.reserved_before,
        "balance_after": row.available_after,
        "description": row.description or None,
        "order_id": str(row.order_id) if row.order_id else None,
        "created_at": row.created_at,
    }
    if row.type == T.CREDIT:
        data["expires_at"] = row.expires_at
    return data


def posted(**filters: Any) -> QuerySet[CoinTransaction]:
    return CoinTransaction.objects.filter(status=LedgerStatus.POSTED, **filters)


def list_transactions(user_id: Any, query: dict[str, Any], page: Page) -> dict[str, Any]:
    """The customer's ledger, newest first."""
    qs = posted(user_id=user_id)
    if query.get("type"):
        qs = qs.filter(type=query["type"])
    if query.get("source"):
        qs = qs.filter(source=query["source"])
    rows, meta = paginate(qs.order_by("-seq"), page)
    return {"items": [customer_txn_view(r) for r in rows], "pagination": meta}


def reconcile(user_id: Any) -> dict[str, Any]:
    """
    Checks a wallet against its ledger: replays every row and compares the balances, checks each
    batch against the allocations that moved it, and checks the balance invariants.
    """
    wallet = CoinWallet.objects.filter(user_id=user_id).first()
    if wallet is None:
        return {"ok": True, "issues": [], "rows": 0}
    rows = list(CoinTransaction.objects.filter(wallet=wallet).order_by("seq"))
    issues: list[str] = []
    replay = dict.fromkeys(COUNTERS, 0)
    for i, row in enumerate(rows):
        if row.seq != i + 1:
            issues.append(f"Row {row.pk} has seq {row.seq}, expected {i + 1}")
        if row.status != LedgerStatus.POSTED:
            issues.append(f"Row {row.pk} is {row.status}")
        if row.available_before != replay["available"] or row.reserved_before != replay["reserved"]:
            issues.append(f"Row {row.pk} does not follow the previous balance")
        c = row.coins
        if row.type == T.CREDIT:
            replay["available"] += c
            replay["total_earned"] += c
        elif row.type == T.RESERVE:
            replay["available"] -= c
            replay["reserved"] += c
        elif row.type == T.DEBIT:
            replay["reserved"] -= c
            replay["total_redeemed"] += c
        elif row.type == T.RELEASE:
            replay["reserved"] -= c
            replay["available"] += c
        elif row.type == T.EXPIRE:
            replay["available"] -= c
            replay["total_expired"] += c
        elif row.reversal_of == ReversalOf.CREDIT:
            replay["available"] -= c
            replay["total_reversed"] += c
            replay["uncollected_reversal"] += row.shortfall or 0
        else:
            replay["available"] += c
            replay["total_redeemed"] -= c
        if row.available_after != replay["available"] or row.reserved_after != replay["reserved"]:
            issues.append(f"Row {row.pk} balances do not match the replay")
    for f in COUNTERS:
        if replay[f] != getattr(wallet, f):
            issues.append(f"{f}: wallet {getattr(wallet, f)}, ledger {replay[f]}")
    if wallet.seq != len(rows):
        issues.append(f"seq: wallet {wallet.seq}, ledger {len(rows)}")
    batches = list(CoinBatch.objects.filter(wallet=wallet))
    giving = Q(transaction__type=T.RELEASE) | Q(
        transaction__type=T.REVERSAL, transaction__reversal_of=ReversalOf.REDEMPTION
    )
    for batch in batches:
        allocations = CoinAllocation.objects.filter(batch=batch)
        given = sum(allocations.filter(giving).values_list("coins", flat=True))
        taken = sum(allocations.exclude(giving).values_list("coins", flat=True))
        if batch.remaining != batch.original - taken + given:
            issues.append(f"Batch {batch.pk} differs from the ledger")
    net = wallet.total_earned - wallet.total_redeemed - wallet.total_expired - wallet.total_reversed
    if net != wallet.available + wallet.reserved:
        issues.append(
            f"earned - redeemed - expired - reversed ({net}) != available + reserved "
            f"({wallet.available + wallet.reserved})"
        )
    if wallet.available != sum(b.remaining for b in batches):
        issues.append("available != sum of batches")
    return {"ok": not issues, "issues": issues, "rows": len(rows)}
