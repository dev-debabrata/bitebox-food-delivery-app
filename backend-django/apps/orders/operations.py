"""
The operations views of the admin panel (Node: services/operations.service.js): a dashboard, the
live order board with late orders first, restaurant availability, and delivery performance.
Actions on orders, restaurants and riders use the existing /admin/orders, /admin/restaurants and
/admin/delivery-partners endpoints.
"""

from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db.models import (
    Avg,
    Count,
    DurationField,
    ExpressionWrapper,
    F,
    Min,
    OuterRef,
    Q,
    Subquery,
    Sum,
)
from django.db.models.functions import TruncDate
from django.utils import timezone

from apps.delivery.models import DeliveryPartner
from apps.dispatch.config import DISPATCH
from apps.dispatch.models import AssignmentStatus
from apps.finance.models import OrderSettlement
from apps.finance.reports import day_keys
from apps.restaurants.models import Restaurant, RestaurantStatus
from apps.restaurants.presenters import is_open_now

from .models import ACTIVE_STATUSES, Order, OrderStatus, OrderStatusHistory

S = OrderStatus

# How long an order may sit in a status before operations should look at it (minutes).
LATE_AFTER_MINUTES: dict[str, int] = {
    S.PENDING: DISPATCH["restaurant_response_minutes"],
    S.CONFIRMED: 30,
    S.PREPARING: 45,
    S.READY_FOR_PICKUP: 15,
    S.ASSIGNED: 20,
    S.ARRIVED_AT_RESTAURANT: 10,  # the rider is waiting at the counter
    S.PICKED_UP: 30,
    S.ON_THE_WAY: 45,
}


def _round1(n: float | None) -> float | None:
    return None if n is None else round(n * 10) / 10


def _received() -> Any:
    """Orders that reached the restaurant (online ones once paid)."""
    return Order.objects.filter(submitted_at__isnull=False)


def dashboard(days: int = 30) -> dict[str, Any]:
    since = timezone.now() - timedelta(days=days)
    counts = (
        _received()
        .filter(created_at__gte=since)
        .aggregate(
            total=Count("pk"),
            completed=Count("pk", filter=Q(status=S.DELIVERED)),
            cancelled=Count("pk", filter=Q(status__in=[S.CANCELLED, S.REJECTED])),
        )
    )
    live = dict(
        _received()
        .filter(status__in=ACTIVE_STATUSES)
        .values("status")
        .annotate(n=Count("pk"))
        .order_by()
        .values_list("status", "n")
    )
    restaurants = list(Restaurant.objects.filter(status=RestaurantStatus.APPROVED))
    riders = DeliveryPartner.objects.aggregate(
        total=Count("pk"),
        online=Count("pk", filter=Q(is_online=True)),
        busy=Count("pk", filter=Q(active_order__isnull=False)),
    )
    return {
        "days": days,
        "orders": {
            "total": counts["total"],
            "completed": counts["completed"],
            "cancelled": counts["cancelled"],
            "pending": live.get(S.PENDING, 0),
            "active": sum(live.values()),
            "by_status": live,
        },
        "restaurants": {
            "total": len(restaurants),
            "open_now": sum(1 for r in restaurants if is_open_now(r)),
            "paused": sum(1 for r in restaurants if not r.is_accepting_orders),
            "awaiting_approval": Restaurant.objects.filter(status=RestaurantStatus.PENDING).count(),
        },
        "riders": riders,
    }


def monitoring(now: datetime | None = None) -> dict[str, Any]:
    """Every live order with how long it has been in its current status; late ones first."""
    now = now or timezone.now()
    orders = (
        _received()
        .filter(status__in=ACTIVE_STATUSES)
        .select_related("delivery_partner")
        .prefetch_related("assignments")
        .order_by("created_at")[:300]
    )
    items = []
    for o in orders:
        minutes = int((now - o.status_changed_at).total_seconds() // 60)
        late_after = LATE_AFTER_MINUTES.get(o.status)
        offer = next((a for a in o.assignments.all() if a.status == AssignmentStatus.OFFERED), None)
        items.append(
            {
                "id": str(o.pk),
                "order_number": o.order_number,
                "status": o.status,
                "restaurant_name": o.restaurant_snapshot.get("name"),
                "rider": {"id": str(o.delivery_partner_id), "name": o.delivery_partner.name}
                if o.delivery_partner
                else None,
                "offered_to": str(offer.rider_id) if offer else None,
                "total_paise": o.total_paise,
                "payment_method": o.payment_method,
                "placed_at": o.created_at,
                "status_since": o.status_changed_at,
                "minutes_in_status": minutes,
                "late": late_after is not None and minutes >= late_after,
            }
        )
    items.sort(key=lambda i: (not i["late"], -i["minutes_in_status"]))
    return {"items": items, "late_after_minutes": LATE_AFTER_MINUTES, "at": now}


def restaurant_availability() -> dict[str, Any]:
    """Approved restaurants: whether they take orders right now, and their live order count."""
    load = dict(
        _received()
        .filter(status__in=ACTIVE_STATUSES)
        .values("restaurant_id")
        .annotate(n=Count("pk"))
        .order_by()
        .values_list("restaurant_id", "n")
    )
    return {
        "items": [
            {
                "id": str(r.pk),
                "name": r.name,
                "slug": r.slug,
                "city": r.city,
                "is_accepting_orders": r.is_accepting_orders,
                "is_open_now": is_open_now(r),
                "hours": f"{r.opening_time}–{r.closing_time}",
                "active_orders": load.get(r.pk, 0),
            }
            for r in Restaurant.objects.filter(status=RestaurantStatus.APPROVED).order_by("name")
        ]
    }


def _entered(status: str) -> Subquery:
    """When the settlement's order first entered `status` (from its status history)."""
    return Subquery(
        OrderStatusHistory.objects.filter(order=OuterRef("order_id"), to_status=status)
        .order_by()
        .values("order")
        .annotate(at=Min("created_at"))
        .values("at")[:1]
    )


def _minutes_of(span: timedelta | None) -> float | None:
    return None if span is None else span.total_seconds() / 60


def _span(end: Any, start: Any) -> ExpressionWrapper:
    return ExpressionWrapper(end - start, output_field=DurationField())


def delivery_performance(days: int = 30) -> dict[str, Any]:
    """
    Over the window: per day, delivered orders and the average minutes from placing to delivery;
    overall, the average time in each stage, the share within 45 minutes, and the top riders.
    Stage times come from the status history; the delivery time is the settlement's. All of it
    is aggregated in the database.
    """
    now = timezone.now()
    tz = ZoneInfo(settings.REPORT_TIMEZONE)
    timed = (
        OrderSettlement.objects.filter(
            settled_at__gte=now - timedelta(days=days), order__status=S.DELIVERED
        )
        .annotate(
            confirmed_at=_entered(S.CONFIRMED),
            ready_at=_entered(S.READY_FOR_PICKUP),
            picked_at=_entered(S.PICKED_UP),
        )
        .annotate(
            total=_span(F("settled_at"), F("order__created_at")),
            prep=_span(F("ready_at"), F("confirmed_at")),
            wait=_span(F("picked_at"), F("ready_at")),
            ride=_span(F("settled_at"), F("picked_at")),
        )
    )
    stats = timed.aggregate(
        delivered=Count("pk"),
        avg_total=Avg("total"),
        avg_prep=Avg("prep"),
        avg_wait=Avg("wait"),
        avg_ride=Avg("ride"),
        within45=Count("pk", filter=Q(total__lte=timedelta(minutes=45))),
    )
    by_day = {
        row["day"].isoformat(): row
        for row in timed.annotate(day=TruncDate("settled_at", tzinfo=tz))
        .values("day")
        .annotate(delivered=Count("pk"), avg_total=Avg("total"))
        .order_by()
    }
    riders = (
        timed.values("order__delivery_partner_id", "order__delivery_partner__name")
        .annotate(deliveries=Count("pk"), avg_ride=Avg("ride"), distance=Sum("order__distance_m"))
        .order_by("-deliveries")[:10]
    )
    delivered = stats["delivered"]
    return {
        "days": days,
        "totals": {
            "delivered": delivered,
            "avg_delivery_minutes": _round1(_minutes_of(stats["avg_total"])),
            "avg_prep_minutes": _round1(_minutes_of(stats["avg_prep"])),
            "avg_pickup_wait_minutes": _round1(_minutes_of(stats["avg_wait"])),
            "avg_ride_minutes": _round1(_minutes_of(stats["avg_ride"])),
            "within45_percent": round(stats["within45"] / delivered * 100) if delivered else None,
        },
        "daily": [
            {
                "date": key,
                "delivered": by_day[key]["delivered"] if key in by_day else 0,
                "avg_minutes": (_round1(_minutes_of(by_day[key]["avg_total"])) or 0)
                if key in by_day
                else 0,
            }
            for key in day_keys(days, now)
        ],
        "top_riders": [
            {
                "id": str(r["order__delivery_partner_id"]),
                "name": r["order__delivery_partner__name"] or "Unknown rider",
                "deliveries": r["deliveries"],
                "avg_ride_minutes": _round1(_minutes_of(r["avg_ride"])),
                "distance_meters": r["distance"] or 0,
            }
            for r in riders
            if r["order__delivery_partner_id"]
        ],
    }


def platform_summary(include_money: bool) -> dict[str, Any]:
    """
    The admin home page's figures (master prompt §3D): people, all-time orders by state, and,
    for roles with finance:view, gross order value, platform revenue and settlements not yet paid
    out (no payout yet, or the payout was cancelled).
    """
    from apps.accounts.models import User
    from apps.finance.models import PayoutStatus
    from apps.rbac.roles import Role

    people = dict(
        User.objects.filter(role__in=[Role.CUSTOMER, Role.RESTAURANT, Role.DELIVERY])
        .values("role")
        .annotate(n=Count("pk"))
        .order_by()
        .values_list("role", "n")
    )
    orders = _received().aggregate(
        total=Count("pk"),
        active=Count("pk", filter=Q(status__in=ACTIVE_STATUSES)),
        completed=Count("pk", filter=Q(status=S.DELIVERED)),
        cancelled=Count("pk", filter=Q(status__in=[S.CANCELLED, S.REJECTED])),
    )
    data: dict[str, Any] = {
        "customers": people.get(Role.CUSTOMER, 0),
        "restaurants": Restaurant.objects.count(),
        "approved_restaurants": Restaurant.objects.filter(status=RestaurantStatus.APPROVED).count(),
        "delivery_partners": people.get(Role.DELIVERY, 0),
        "orders": orders,
    }
    if include_money:
        unpaid = Q(restaurant_payout__isnull=True) | Q(
            restaurant_payout__status=PayoutStatus.CANCELLED
        )
        rider_unpaid = Q(rider_payout__isnull=True) | Q(rider_payout__status=PayoutStatus.CANCELLED)
        settled = OrderSettlement.objects.filter(order__status=S.DELIVERED)
        money = settled.aggregate(
            gmv=Sum("order__total_paise"),
            platform=Sum("platform_paise"),
            restaurants_due=Sum("restaurant_paise", filter=unpaid),
            riders_due=Sum("rider_paise", filter=rider_unpaid),
        )
        data["money"] = {
            "gmv_paise": money["gmv"] or 0,
            "platform_revenue_paise": money["platform"] or 0,
            "pending_settlements_paise": (money["restaurants_due"] or 0)
            + (money["riders_due"] or 0),
            "pending_restaurant_paise": money["restaurants_due"] or 0,
            "pending_rider_paise": money["riders_due"] or 0,
        }
    return data
