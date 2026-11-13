"""
The double-entry finance ledger (master prompt: ledger entries, reconciliation).

Every event posts one group whose signed amounts sum to zero, exactly once (`key` + account is
unique, so a repeat is a no-op):

- an order delivered:  customer_payments +total; restaurant_payable, rider_payable, tax_payable
  and platform_revenue take their negative shares;
- a payout paid:       the payee's payable +amount; payouts −amount;
- a refund after delivery: customer_payments −amount; restaurant_payable +deducted (the part
  taken from the restaurant's unpaid share); platform_revenue +the rest.

Rows are immutable (a database trigger refuses updates and deletes).
"""

import uuid
from datetime import datetime, timedelta
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Count, Sum
from django.utils import timezone

from common.pagination import Page, paginate

from .models import LedgerAccount, LedgerEntry, OrderSettlement, Payout, PayoutType

A = LedgerAccount


def post(
    key: str,
    lines: list[tuple[str, int]],
    *,
    order: Any = None,
    payout: Any = None,
    description: str = "",
) -> bool:
    """Posts one balanced group. False when this event was posted before."""
    amounts = [(account, amount) for account, amount in lines if amount]
    if sum(a for _, a in amounts) != 0:
        raise ValueError(f"Unbalanced ledger group {key}")
    if LedgerEntry.objects.filter(key=key).exists():
        return False
    group = uuid.uuid4()
    try:
        with transaction.atomic():
            LedgerEntry.objects.bulk_create(
                [
                    LedgerEntry(
                        entry_group=group,
                        key=key,
                        account=account,
                        amount_paise=amount,
                        order=order,
                        payout=payout,
                        description=description[:200],
                    )
                    for account, amount in amounts
                ]
            )
    except IntegrityError:  # the same event at the same moment
        return False
    return True


def post_settlement(settlement: OrderSettlement) -> bool:
    order = settlement.order
    tax = order.tax_paise
    return post(
        f"settle:{order.pk}",
        [
            (A.CUSTOMER_PAYMENTS, order.total_paise),
            (A.RESTAURANT_PAYABLE, -settlement.restaurant_paise),
            (A.RIDER_PAYABLE, -settlement.rider_paise),
            (A.TAX_PAYABLE, -tax),
            (A.PLATFORM_REVENUE, -(settlement.platform_paise - tax)),
        ],
        order=order,
        description=f"Order {order.order_number} delivered",
    )


def post_payout_paid(payout: Payout) -> bool:
    payable = A.RESTAURANT_PAYABLE if payout.type == PayoutType.RESTAURANT else A.RIDER_PAYABLE
    return post(
        f"payout:{payout.pk}",
        [(payable, payout.amount_paise), (A.PAYOUTS, -payout.amount_paise)],
        payout=payout,
        description=f"Payout to {payout.payee_name}",
    )


def post_refund(order: Any, refund_id: Any, amount: int, from_restaurant: int) -> bool:
    return post(
        f"refund:{refund_id}",
        [
            (A.CUSTOMER_PAYMENTS, -amount),
            (A.RESTAURANT_PAYABLE, from_restaurant),
            (A.PLATFORM_REVENUE, amount - from_restaurant),
        ],
        order=order,
        description=f"Refund on order {order.order_number}",
    )


def summary(days: int, page: Page, now: datetime | None = None) -> dict[str, Any]:
    """Balances per account (all time and in the window), whether every group balances, and the
    newest entries."""
    since = (now or timezone.now()) - timedelta(days=days)
    totals = dict(
        LedgerEntry.objects.values_list("account").annotate(s=Sum("amount_paise")).order_by()
    )
    window = dict(
        LedgerEntry.objects.filter(created_at__gte=since)
        .values_list("account")
        .annotate(s=Sum("amount_paise"))
        .order_by()
    )
    unbalanced = (
        LedgerEntry.objects.values("entry_group")
        .annotate(s=Sum("amount_paise"))
        .exclude(s=0)
        .aggregate(n=Count("entry_group"))["n"]
    )
    rows, meta = paginate(LedgerEntry.objects.select_related("order").order_by("-created_at"), page)
    return {
        "days": days,
        "accounts": [
            {
                "account": account,
                "balance_paise": totals.get(account, 0),
                "period_paise": window.get(account, 0),
            }
            for account in A.values
        ],
        "balanced": unbalanced == 0,
        "unbalanced_groups": unbalanced,
        "items": [
            {
                "id": str(e.pk),
                "group": str(e.entry_group),
                "account": e.account,
                "amount_paise": e.amount_paise,
                "description": e.description,
                "order_number": e.order.order_number if e.order else None,
                "created_at": e.created_at,
            }
            for e in rows
        ],
        "pagination": meta,
    }
