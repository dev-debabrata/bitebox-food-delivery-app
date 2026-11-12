"""
Earnings reports (Node: services/reports.service.js#earnings). Built from the settlement each
delivered order gets (apps/finance/models.py#OrderSettlement); days are grouped in
settings.REPORT_TIMEZONE, and every day of the window appears, quiet days included.
"""

from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db.models import Count, F, Sum
from django.db.models.functions import TruncDate
from django.utils import timezone

from apps.accounts.models import User
from apps.restaurants.models import Restaurant
from common.api import ApiError

from .models import OrderSettlement


def day_keys(days: int, now: datetime | None = None) -> list[str]:
    """Every day of the window, oldest first, as YYYY-MM-DD in the report time zone."""
    tz = ZoneInfo(settings.REPORT_TIMEZONE)
    now = now or timezone.now()
    return [
        (now - timedelta(days=days - 1 - i)).astimezone(tz).strftime("%Y-%m-%d")
        for i in range(days)
    ]


def _earnings(share: str, days: int, **match: Any) -> dict[str, Any]:
    now = timezone.now()
    settled = OrderSettlement.objects.filter(
        settled_at__gte=now - timedelta(days=days), order__status="delivered", **match
    )
    tz = ZoneInfo(settings.REPORT_TIMEZONE)
    daily_rows = (
        settled.annotate(day=TruncDate("settled_at", tzinfo=tz))
        .values("day")
        .annotate(
            orders=Count("pk"),
            earnings_paise=Sum(share),
            distance_meters=Sum("order__distance_m"),
        )
        .order_by()
    )
    by_day = {row["day"].isoformat(): row for row in daily_rows}
    daily = [
        {
            "date": key,
            "orders": by_day.get(key, {}).get("orders", 0),
            "earnings_paise": by_day.get(key, {}).get("earnings_paise", 0) or 0,
            "distance_meters": by_day.get(key, {}).get("distance_meters", 0) or 0,
        }
        for key in day_keys(days, now)
    ]
    recent = settled.select_related("order").annotate(earned=F(share)).order_by("-settled_at")[:20]
    return {
        "days": days,
        "totals": {
            field: sum(row[field] for row in by_day.values()) or 0
            for field in ("orders", "earnings_paise", "distance_meters")
        },
        "daily": daily,
        "recent": [
            {
                "id": str(s.order_id),
                "order_number": s.order.order_number,
                "restaurant_name": s.order.restaurant_snapshot.get("name"),
                "area": s.order.delivery_address.get("area")
                or s.order.delivery_address.get("city"),
                "total_paise": s.order.total_paise,
                "distance_meters": s.order.distance_m,
                "earnings_paise": s.earned,
                "delivered_at": s.settled_at,
            }
            for s in recent
        ],
    }


def restaurant_earnings(owner: User, days: int = 30) -> dict[str, Any]:
    restaurant_id = Restaurant.objects.filter(owner=owner).values_list("pk", flat=True).first()
    if restaurant_id is None:
        raise ApiError.not_found("Create your restaurant first")
    return _earnings("restaurant_paise", days, order__restaurant_id=restaurant_id)


def rider_earnings(user: User, days: int = 30) -> dict[str, Any]:
    return _earnings("rider_paise", days, order__delivery_partner=user)


def rider_stats(user: User) -> dict[str, Any]:
    """
    The rider dashboard's figures: today and this week (Monday onwards), in REPORT_TIMEZONE,
    from the settlements of delivered orders; all-time totals; the rating.
    """
    from apps.delivery.models import DeliveryPartner

    tz = ZoneInfo(settings.REPORT_TIMEZONE)
    local_now = timezone.now().astimezone(tz)
    start_of_today = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    start_of_week = start_of_today - timedelta(days=start_of_today.weekday())
    mine = OrderSettlement.objects.filter(order__delivery_partner=user, order__status="delivered")

    def window(since: datetime | None) -> dict[str, int]:
        qs = mine.filter(settled_at__gte=since) if since else mine
        row = qs.aggregate(deliveries=Count("pk"), earnings=Sum("rider_paise"))
        return {"deliveries": row["deliveries"] or 0, "earnings_paise": row["earnings"] or 0}

    profile = DeliveryPartner.objects.filter(user=user).first()
    return {
        "today": window(start_of_today),
        "week": window(start_of_week),
        "total": window(None),
        "rating": {
            "average": float(profile.rating_average) if profile else 0.0,
            "count": profile.rating_count if profile else 0,
        },
    }


def admin_report(days: int = 30) -> dict[str, Any]:
    """
    Platform analytics over orders placed in the window (Node: reports.service.js#adminReport):
    per-day orders, deliveries and GMV; cancellations, platform revenue and refunds; payment mix
    and top restaurants among delivered orders; status counts; new customers.
    """
    from django.db.models import Q

    from apps.accounts.models import User
    from apps.orders.models import Order, OrderStatus, PaymentStatus
    from apps.rbac.roles import Role

    now = timezone.now()
    since = now - timedelta(days=days)
    tz = ZoneInfo(settings.REPORT_TIMEZONE)
    placed = Order.objects.filter(created_at__gte=since)
    delivered_q = Q(status=OrderStatus.DELIVERED)

    daily_rows = (
        placed.annotate(day=TruncDate("created_at", tzinfo=tz))
        .values("day")
        .annotate(
            orders=Count("pk"),
            delivered=Count("pk", filter=delivered_q),
            gmv_paise=Sum("total_paise", filter=delivered_q),
        )
        .order_by()
    )
    by_day = {row["day"].isoformat(): row for row in daily_rows}
    daily = [
        {
            "date": key,
            "orders": by_day.get(key, {}).get("orders", 0),
            "delivered": by_day.get(key, {}).get("delivered", 0),
            "gmv_paise": by_day.get(key, {}).get("gmv_paise") or 0,
        }
        for key in day_keys(days, now)
    ]
    totals = {
        field: sum((row[field] or 0) for row in by_day.values())
        for field in ("orders", "delivered", "gmv_paise")
    }
    money = placed.aggregate(
        cancelled=Count("pk", filter=Q(status__in=[OrderStatus.CANCELLED, OrderStatus.REJECTED])),
        platform_revenue_paise=Sum("settlement__platform_paise"),
        refunded_paise=Sum("total_paise", filter=Q(payment_status=PaymentStatus.REFUNDED)),
    )
    delivered = placed.filter(delivered_q)
    payment_mix = (
        delivered.values("payment_method")
        .annotate(orders=Count("pk"), paise=Sum("total_paise"))
        .order_by("payment_method")
    )
    top = (
        delivered.values("restaurant_id")
        .annotate(orders=Count("pk"), gmv_paise=Sum("total_paise"))
        .order_by("-gmv_paise")[:5]
    )
    names = dict(
        Restaurant.objects.filter(pk__in=[t["restaurant_id"] for t in top]).values_list(
            "pk", "name"
        )
    )
    return {
        "days": days,
        "totals": {
            **totals,
            "cancelled": money["cancelled"] or 0,
            "platform_revenue_paise": money["platform_revenue_paise"] or 0,
            "refunded_paise": money["refunded_paise"] or 0,
            "average_order_paise": round(totals["gmv_paise"] / totals["delivered"])
            if totals["delivered"]
            else 0,
            "new_customers": User.objects.filter(role=Role.CUSTOMER, created_at__gte=since).count(),
        },
        "daily": daily,
        "payment_mix": [
            {"method": p["payment_method"], "orders": p["orders"], "paise": p["paise"]}
            for p in payment_mix
        ],
        "status_counts": dict(
            placed.values("status").annotate(n=Count("pk")).order_by().values_list("status", "n")
        ),
        "top_restaurants": [
            {
                "id": str(t["restaurant_id"]),
                "name": names.get(t["restaurant_id"], ""),
                "orders": t["orders"],
                "gmv_paise": t["gmv_paise"],
            }
            for t in top
        ],
    }
