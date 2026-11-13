"""
Finance (Node: services/finance.service.js), plus master prompt §3D/§8:

- the admin dashboard, transaction details, refund queue and commission report (Node parity);
- payouts: what each restaurant or rider is owed, batched into payouts that are marked paid or
  cancelled. A settlement is claimed by at most one payout (one conditional update);
- commission rules: a global rate and per-restaurant overrides, with history;
- refund deductions: a refund after delivery comes off the restaurant's unpaid share;
- settlement and payout history for restaurants and riders;
- every money event is also posted to the ledger (ledger.py).
"""

import csv
import io
from datetime import datetime, timedelta
from typing import Any

from django.db import transaction
from django.db.models import Count, F, Max, Min, Q, Sum
from django.db.models.functions import TruncDate
from django.utils import timezone

from apps.accounts.models import User
from apps.orders.models import Order, OrderStatus, PaymentMethod, PaymentStatus
from apps.orders.notifications import rupees
from apps.payments.models import Payment
from apps.restaurants.models import Restaurant
from common.api import ApiError
from common.pagination import Page, paginate

from . import ledger
from .earnings import EARNINGS
from .models import CommissionRule, OrderSettlement, Payout, PayoutStatus, PayoutType
from .reports import day_keys

S = OrderStatus
P = PaymentStatus
CLOSED = (S.CANCELLED, S.REJECTED)
COLLECTED = (P.PAID, P.REFUNDED, P.PARTIALLY_REFUNDED)

# Each payout type: the settlement's payout link and the share it pays.
SIDE: dict[str, dict[str, str]] = {
    PayoutType.RESTAURANT: {"link": "restaurant_payout", "share": "restaurant"},
    PayoutType.RIDER: {"link": "rider_payout", "share": "rider"},
}


def _since(days: int) -> datetime:
    return timezone.now() - timedelta(days=days)


def _share(type: str) -> Any:
    """What a settlement pays this payee: the rider's pay, or the restaurant's share net of
    refunds taken from it."""
    if type == PayoutType.RIDER:
        return F("rider_paise")
    return F("restaurant_paise") - F("refund_adjustment_paise")


def _due(type: str) -> Any:
    """Delivered orders' settlements not yet in a payout of this type."""
    return OrderSettlement.objects.filter(
        order__status=S.DELIVERED, **{f"{SIDE[type]['link']}__isnull": True}
    )


# ---------------------------------------------------------------------------
# Dashboard, transactions, refunds, commission report (Node parity)
# ---------------------------------------------------------------------------
def dashboard(days: int) -> dict[str, Any]:
    payments = Payment.objects.filter(created_at__gte=_since(days))
    pay = payments.aggregate(
        transactions=Count("pk"),
        successful=Count("pk", filter=Q(status__in=COLLECTED)),
        failed=Count("pk", filter=Q(status=P.FAILED)),
        pending=Count("pk", filter=Q(status=P.PENDING)),
        collected=Sum("amount_paise", filter=Q(status__in=COLLECTED)),
        refunds=Count("pk", filter=Q(refunded_paise__gt=0)),
        refunded=Sum("refunded_paise"),
    )
    from zoneinfo import ZoneInfo

    from django.conf import settings

    tz = ZoneInfo(settings.REPORT_TIMEZONE)
    by_day = {
        r["day"].isoformat(): r["paise"]
        for r in payments.filter(status=P.PAID, paid_at__isnull=False)
        .annotate(day=TruncDate("paid_at", tzinfo=tz))
        .values("day")
        .annotate(paise=Sum("amount_paise"))
        .order_by()
    }
    settled = OrderSettlement.objects.filter(
        order__status=S.DELIVERED, settled_at__gte=_since(days)
    ).aggregate(
        platform=Sum("platform_paise"), restaurant=Sum("restaurant_paise"), rider=Sum("rider_paise")
    )
    due = sum(_due(t).aggregate(paise=Sum(_share(t)))["paise"] or 0 for t in PayoutType.values)
    pending = Payout.objects.filter(status=PayoutStatus.PENDING).aggregate(
        n=Count("pk"), paise=Sum("amount_paise")
    )
    collected, refunded = pay["collected"] or 0, pay["refunded"] or 0
    return {
        "days": days,
        "totals": {
            "revenue_paise": collected - refunded,
            "transactions": pay["transactions"],
            "successful_payments": pay["successful"],
            "failed_payments": pay["failed"],
            "pending_payments": pay["pending"],
            "refunds": pay["refunds"],
            "refunded_paise": refunded,
            "platform_commission_paise": settled["platform"] or 0,
            "restaurant_earnings_paise": settled["restaurant"] or 0,
            "rider_earnings_paise": settled["rider"] or 0,
            # Owed to partners: earned but not yet in a payout, plus unpaid payouts.
            "pending_payout_paise": due + (pending["paise"] or 0),
            "pending_payout_batches": pending["n"],
        },
        "daily": [{"date": d, "revenue_paise": by_day.get(d, 0)} for d in day_keys(days)],
    }


def _pricing(o: Order) -> dict[str, int]:
    return {
        "subtotal_paise": o.subtotal_paise,
        "discount_paise": o.discount_paise,
        "delivery_fee_paise": o.delivery_fee_paise,
        "platform_fee_paise": o.platform_fee_paise,
        "tax_paise": o.tax_paise,
        "coin_discount_paise": o.coin_discount_paise,
        "total_paise": o.total_paise,
    }


def transaction_detail(payment_id: Any) -> dict[str, Any]:
    """One payment with its customer, order prices and settlement (transaction details)."""
    from apps.orders.presenters import payment_view

    p = Payment.objects.select_related("user", "order").filter(pk=payment_id).first()
    if p is None:
        raise ApiError.not_found("Transaction not found")
    o = p.order
    s = OrderSettlement.objects.filter(order=o).first()
    cancellation = getattr(o, "cancellation", None)
    last_refund = p.refunds.exclude(provider_refund_id=None).order_by("-created_at").first()
    return {
        "transaction": {
            "id": str(p.pk),
            **payment_view(p),
            "provider_order_id": p.provider_order_id,
            "provider_payment_id": p.provider_payment_id,
            "provider_refund_id": last_refund.provider_refund_id if last_refund else None,
            "created_at": p.created_at,
            "customer": {
                "id": str(p.user_id),
                "name": p.user.name,
                "email": p.user.email,
                "phone": p.user.phone,
            },
            "order": {
                "id": str(o.pk),
                "order_number": o.order_number,
                "status": o.status,
                "restaurant_name": o.restaurant_snapshot.get("name"),
                "pricing": _pricing(o),
                "settlement": _settlement_json(s) if s else None,
                "cancellation": {"by": cancellation.by, "reason": cancellation.reason or None}
                if cancellation
                else None,
                "paid_out": {
                    "restaurant": bool(s and s.restaurant_payout_id),
                    "rider": bool(s and s.rider_payout_id),
                },
                "created_at": o.created_at,
            },
        }
    }


def _settlement_json(s: OrderSettlement) -> dict[str, Any]:
    return {
        "restaurant_paise": s.restaurant_paise,
        "rider_paise": s.rider_paise,
        "platform_paise": s.platform_paise,
        "commission_bp": s.commission_bp,
        "refund_adjustment_paise": s.refund_adjustment_paise,
        "at": s.settled_at,
    }


def refunds(state: str | None, page: Page) -> dict[str, Any]:
    """Online payments refunded (fully or partly), plus paid ones of closed orders that still
    need a refund (the automatic one failed)."""
    needed = Q(status=P.PAID, method=PaymentMethod.ONLINE, order__status__in=CLOSED)
    done = Q(status__in=[P.REFUNDED, P.PARTIALLY_REFUNDED])
    where = needed if state == "needed" else done if state == "refunded" else needed | done
    qs = Payment.objects.filter(where).select_related("order", "user").order_by("-updated_at")
    from apps.orders.presenters import payment_view

    rows, meta = paginate(qs, page)
    return {
        "items": [
            {
                "id": str(p.pk),
                **payment_view(p),
                "refund_needed": p.status == P.PAID,
                "customer": {"name": p.user.name, "email": p.user.email},
                "order": {
                    "id": str(p.order_id),
                    "order_number": p.order.order_number,
                    "status": p.order.status,
                    "reason": getattr(getattr(p.order, "cancellation", None), "reason", None)
                    or None,
                },
                "updated_at": p.updated_at,
            }
            for p in rows
        ],
        "pagination": meta,
    }


def commission_report(days: int) -> dict[str, Any]:
    rows = (
        OrderSettlement.objects.filter(order__status=S.DELIVERED, settled_at__gte=_since(days))
        .values("order__restaurant_id")
        .annotate(
            name=Max("order__restaurant__name"),
            orders=Count("pk"),
            food=Sum(F("order__subtotal_paise") - F("order__discount_paise")),
            restaurant=Sum("restaurant_paise"),
            platform=Sum("platform_paise"),
        )
        .order_by("-platform")
    )
    items = [
        {
            "restaurant_id": str(r["order__restaurant_id"]),
            "name": r["name"],
            "orders": r["orders"],
            "food_paise": r["food"] or 0,
            "commission_paise": (r["food"] or 0) - (r["restaurant"] or 0),
            "restaurant_paise": r["restaurant"] or 0,
            "platform_paise": r["platform"] or 0,
        }
        for r in rows
    ]
    global_bp = active_rate(None)
    return {
        "days": days,
        "rates": {
            "restaurant_commission_percent": global_bp / 100,
            "rider_base_paise": EARNINGS["rider_base_paise"],
            "rider_per_km_paise": EARNINGS["rider_per_km_paise"],
        },
        "totals": {
            k: sum(i[f] for i in items)
            for k, f in (
                ("orders", "orders"),
                ("food_paise", "food_paise"),
                ("commission_paise", "commission_paise"),
                ("platform_paise", "platform_paise"),
            )
        },
        "items": items,
    }


# ---------------------------------------------------------------------------
# Commission rules
# ---------------------------------------------------------------------------
def active_rate(restaurant_id: Any) -> int:
    """The open rule of this scope (None = global); the global/default when there is none."""
    from .earnings import commission_bp_for

    if restaurant_id is None:
        rule = CommissionRule.objects.filter(
            restaurant__isnull=True, effective_to__isnull=True
        ).first()
        return rule.basis_points if rule else EARNINGS["restaurant_commission_basis_points"]
    return commission_bp_for(restaurant_id)


def _rule_json(r: CommissionRule) -> dict[str, Any]:
    return {
        "id": str(r.pk),
        "restaurant": {"id": str(r.restaurant_id), "name": r.restaurant.name}
        if r.restaurant
        else None,
        "basis_points": r.basis_points,
        "percent": r.basis_points / 100,
        "effective_from": r.effective_from,
        "effective_to": r.effective_to,
        "note": r.note or None,
        "created_by": r.created_by.name if r.created_by else None,
    }


def commission_rules() -> dict[str, Any]:
    """The global rate, every restaurant override in force, and the recent history."""
    rules = CommissionRule.objects.select_related("restaurant", "created_by")
    return {
        "global": {
            "basis_points": active_rate(None),
            "percent": active_rate(None) / 100,
            "default_basis_points": EARNINGS["restaurant_commission_basis_points"],
        },
        "overrides": [
            _rule_json(r)
            for r in rules.filter(restaurant__isnull=False, effective_to__isnull=True).order_by(
                "restaurant__name"
            )
        ],
        "history": [_rule_json(r) for r in rules.order_by("-effective_from")[:50]],
    }


def set_commission(actor: User, restaurant_id: Any, basis_points: int, note: str) -> dict[str, Any]:
    """A new rate for a scope (None = global): the open rule closes, a new one opens."""
    if restaurant_id is not None and not Restaurant.objects.filter(pk=restaurant_id).exists():
        raise ApiError.not_found("Restaurant not found")
    now = timezone.now()
    with transaction.atomic():
        scope = Q(restaurant_id=restaurant_id) if restaurant_id else Q(restaurant__isnull=True)
        CommissionRule.objects.select_for_update().filter(scope, effective_to__isnull=True).update(
            effective_to=now, updated_at=now
        )
        CommissionRule.objects.create(
            restaurant_id=restaurant_id,
            basis_points=basis_points,
            effective_from=now,
            note=note,
            created_by=actor,
        )
    return commission_rules()


def clear_commission(restaurant_id: Any) -> dict[str, Any]:
    """Removes a restaurant's own rate: the global one applies again."""
    now = timezone.now()
    closed = CommissionRule.objects.filter(
        restaurant_id=restaurant_id, effective_to__isnull=True
    ).update(effective_to=now, updated_at=now)
    if not closed:
        raise ApiError.not_found("This restaurant has no commission of its own")
    return commission_rules()


# ---------------------------------------------------------------------------
# Payouts
# ---------------------------------------------------------------------------
def payouts_due(type: str) -> dict[str, Any]:
    payee = (
        "order__restaurant_id" if type == PayoutType.RESTAURANT else "order__delivery_partner_id"
    )
    rows = (
        _due(type)
        .values(payee)
        .annotate(
            orders=Count("pk"),
            amount=Sum(_share(type)),
            first=Min("settled_at"),
            last=Max("settled_at"),
            restaurant_name=Max("order__restaurant__name"),
            rider_name=Max("order__delivery_partner__name"),
        )
        .order_by("-amount")
    )
    return {
        "type": type,
        "items": [
            {
                "payee_id": str(r[payee]),
                "name": r["restaurant_name"] if type == PayoutType.RESTAURANT else r["rider_name"],
                "orders": r["orders"],
                "amount_paise": r["amount"] or 0,
                "from": r["first"],
                "to": r["last"],
            }
            for r in rows
            if r[payee]
        ],
    }


def payout_json(p: Payout) -> dict[str, Any]:
    return {
        "id": str(p.pk),
        "type": p.type,
        "restaurant": str(p.restaurant_id) if p.restaurant_id else None,
        "payee": str(p.payee_id),
        "payee_name": p.payee_name,
        "orders": p.orders_count,
        "amount_paise": p.amount_paise,
        "period_from": p.period_from,
        "period_to": p.period_to,
        "status": p.status,
        "reference": p.reference or None,
        "note": p.note or None,
        "paid_at": p.paid_at,
        "created_at": p.created_at,
        "updated_at": p.updated_at,
    }


def create_payout(actor: User, type: str, payee_id: Any, note: str) -> dict[str, Any]:
    """Everything a payee is owed now, in one payout. Settlements are claimed with one
    conditional update, so none can land in two payouts even if two admins click at once."""
    if type == PayoutType.RESTAURANT:
        restaurant = Restaurant.objects.filter(pk=payee_id).first()
        if restaurant is None:
            raise ApiError.not_found("Restaurant not found")
        payee, name, owner = restaurant.owner, restaurant.name, {"order__restaurant_id": payee_id}
    else:
        rider = User.objects.filter(pk=payee_id).first()
        if rider is None:
            raise ApiError.not_found("Rider not found")
        restaurant, payee, name = None, rider, rider.name
        owner = {"order__delivery_partner_id": payee_id}
    link = SIDE[type]["link"]
    with transaction.atomic():
        payout = Payout.objects.create(
            type=type,
            restaurant=restaurant,
            payee=payee,
            payee_name=name,
            note=note or "",
            created_by=actor,
        )
        claimed = _due(type).filter(**owner).update(**{link: payout})
        if not claimed:
            raise ApiError.bad_request("Nothing is due for this payee")
        totals = OrderSettlement.objects.filter(**{link: payout}).aggregate(
            orders=Count("pk"),
            amount=Sum(_share(type)),
            first=Min("settled_at"),
            last=Max("settled_at"),
        )
        Payout.objects.filter(pk=payout.pk).update(
            orders_count=totals["orders"],
            amount_paise=max(0, totals["amount"] or 0),
            period_from=totals["first"],
            period_to=totals["last"],
        )
        payout.refresh_from_db()
    return payout_json(payout)


def mark_payout_paid(actor: User, payout_id: Any, reference: str) -> dict[str, Any]:
    from apps.notifications.services import notify

    now = timezone.now()
    with transaction.atomic():
        updated = Payout.objects.filter(pk=payout_id, status=PayoutStatus.PENDING).update(
            status=PayoutStatus.PAID,
            reference=reference,
            paid_by=actor,
            paid_at=now,
            updated_at=now,
        )
        if not updated:
            raise ApiError.conflict("Only a pending payout can be marked as paid")
        payout = Payout.objects.get(pk=payout_id)
        ledger.post_payout_paid(payout)
    # The "settlement processed" event (master prompt §11).
    notify(
        payout.payee_id,
        type="payout.paid",
        title=f"Payout of {rupees(payout.amount_paise)} sent",
        body=f"For {payout.orders_count} orders. Bank reference {reference}.",
        link="/restaurant/earnings"
        if payout.type == PayoutType.RESTAURANT
        else "/delivery/earnings",
    )
    return payout_json(payout)


def cancel_payout(payout_id: Any, note: str | None) -> dict[str, Any]:
    """A pending payout is cancelled and its settlements show as due again."""
    with transaction.atomic():
        fields: dict[str, Any] = {"status": PayoutStatus.CANCELLED, "updated_at": timezone.now()}
        if note:
            fields["note"] = note
        if not Payout.objects.filter(pk=payout_id, status=PayoutStatus.PENDING).update(**fields):
            raise ApiError.conflict("Only a pending payout can be cancelled")
        payout = Payout.objects.get(pk=payout_id)
        OrderSettlement.objects.filter(**{SIDE[payout.type]["link"]: payout}).update(
            **{SIDE[payout.type]["link"]: None}
        )
    return payout_json(payout)


def list_payouts(query: dict[str, Any], page: Page, **scope: Any) -> dict[str, Any]:
    qs = Payout.objects.filter(**scope)
    for field in ("type", "status"):
        if query.get(field):
            qs = qs.filter(**{field: query[field]})
    rows, meta = paginate(qs.order_by("-created_at"), page)
    return {"items": [payout_json(p) for p in rows], "pagination": meta}


# ---------------------------------------------------------------------------
# Refund deductions
# ---------------------------------------------------------------------------
def apply_refund(order: Order, refund_id: Any, amount: int) -> None:
    """
    A refund finished on a delivered order: it comes off the restaurant's share while that is
    not yet in a payout (never below zero); BiteBox carries the rest. Posted to the ledger once.
    """
    with transaction.atomic():
        s = OrderSettlement.objects.select_for_update().filter(order=order).first()
        if s is None:
            return  # not delivered: nothing was settled
        deducted = 0
        if s.restaurant_payout_id is None:
            room = s.restaurant_paise - s.refund_adjustment_paise
            deducted = max(0, min(amount, room))
            if (
                deducted
                and not ledger.LedgerEntry.objects.filter(key=f"refund:{refund_id}").exists()
            ):
                OrderSettlement.objects.filter(pk=s.pk).update(
                    refund_adjustment_paise=F("refund_adjustment_paise") + deducted
                )
        ledger.post_refund(order, refund_id, amount, deducted)


# ---------------------------------------------------------------------------
# Partner history
# ---------------------------------------------------------------------------
def restaurant_of(owner: User) -> Restaurant:
    restaurant = Restaurant.objects.filter(owner=owner).first()
    if restaurant is None:
        raise ApiError.not_found("Create your restaurant first")
    return restaurant


def settlement_history(page: Page, type: str, **scope: Any) -> dict[str, Any]:
    """Per delivered order: what it paid this partner and whether it has been paid out."""
    link = SIDE[type]["link"]
    qs = (
        OrderSettlement.objects.filter(order__status=S.DELIVERED, **scope)
        .select_related("order", link)
        .order_by("-settled_at")
    )
    rows, meta = paginate(qs, page)
    items = []
    for s in rows:
        o = s.order
        payout = getattr(s, link)
        food = o.subtotal_paise - o.discount_paise
        net = (
            s.rider_paise
            if type == PayoutType.RIDER
            else s.restaurant_paise - s.refund_adjustment_paise
        )
        items.append(
            {
                "order_id": str(o.pk),
                "order_number": o.order_number,
                "settled_at": s.settled_at,
                "food_paise": food,
                "commission_bp": s.commission_bp,
                "commission_paise": food - s.restaurant_paise,
                "refund_adjustment_paise": s.refund_adjustment_paise,
                "net_paise": net,
                "payout": {"id": str(payout.pk), "status": payout.status, "paid_at": payout.paid_at}
                if payout
                else None,
            }
        )
    return {"items": items, "pagination": meta}


def spreadsheet_safe(text: str) -> str:
    """Text a spreadsheet would run as a formula (starts with = + - @, tab or CR): quote it."""
    return f"'{text}" if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def settlements_csv(start: datetime | None, end: datetime | None) -> str:
    """The settlement report (one row per delivered order) for spreadsheets and accountants."""
    qs = OrderSettlement.objects.filter(order__status=S.DELIVERED).select_related(
        "order", "restaurant_payout", "rider_payout"
    )
    if start:
        qs = qs.filter(settled_at__gte=start)
    if end:
        qs = qs.filter(settled_at__lte=end)
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(
        [
            "Order", "Delivered at", "Restaurant", "Order total (₹)", "Tax (₹)", "Commission %",
            "Restaurant share (₹)", "Refund deduction (₹)", "Rider pay (₹)", "BiteBox share (₹)",
            "Restaurant payout", "Rider payout",
        ]
    )  # fmt: skip
    money = lambda p: f"{p / 100:.2f}"  # noqa: E731
    for s in qs.order_by("settled_at").iterator():
        o = s.order
        writer.writerow(
            [
                o.order_number,
                s.settled_at.isoformat(),
                spreadsheet_safe(o.restaurant_snapshot.get("name", "")),  # partner-written
                money(o.total_paise),
                money(o.tax_paise),
                f"{s.commission_bp / 100:g}",
                money(s.restaurant_paise),
                money(s.refund_adjustment_paise),
                money(s.rider_paise),
                money(s.platform_paise),
                s.restaurant_payout.status if s.restaurant_payout else "due",
                s.rider_payout.status if s.rider_payout else "due",
            ]
        )
    return out.getvalue()
