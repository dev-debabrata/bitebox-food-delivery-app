"""
Special rewards (Node: services/special-rewards.service.js): welcome and birthday bonuses
(configured globally) and festival / promotional campaigns (created by the super admin). Every
reward is a RewardClaim with a unique key, then a ledger credit keyed by the claim, so nothing
can be paid twice.
"""

import logging
from collections.abc import Callable
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from django.db import IntegrityError, transaction
from django.db.models import Count, F, Q, Sum
from django.utils import timezone

from apps.accounts.models import User, UserStatus
from apps.notifications.services import notify
from apps.orders.models import Order, OrderStatus
from apps.rbac.roles import Role
from apps.restaurants.models import Restaurant
from common.api import ApiError
from common.pagination import Page, paginate

from . import wallet
from .models import (
    CampaignStatus,
    CampaignTrigger,
    CampaignType,
    ClaimStatus,
    CustomerGroup,
    RewardCampaign,
    RewardClaim,
    RewardType,
)
from .orders import food_value_paise
from .quote import get_reward_config, rule_on
from .referrals import person

logger = logging.getLogger("bitebox.coins")

CS = CampaignStatus
G = CustomerGroup
SOURCE_FOR = {
    RewardType.WELCOME: "WELCOME_REWARD",
    RewardType.BIRTHDAY: "BIRTHDAY_REWARD",
    RewardType.FESTIVAL: "FESTIVAL_REWARD",
    RewardType.PROMOTIONAL: "PROMOTIONAL_REWARD",
}
GROUP_REASON = {
    G.NEW: "For customers who have not ordered yet",
    G.EXISTING: "For customers who have ordered before",
    G.INACTIVE: "For customers who have not ordered for a while",
}


def _conflict(message: str, code: str) -> ApiError:
    return ApiError.conflict(message, code)


def _invalid(field: str, message: str) -> ApiError:
    return ApiError(
        422,
        "Validation failed",
        code="VALIDATION_ERROR",
        details=[{"field": field, "message": message}],
    )


# ---------------------------------------------------------------------------
# Claims
# ---------------------------------------------------------------------------
def _issue(
    claim: RewardClaim,
    *,
    description: str,
    title: str | None = None,
    link: str = "/account/rewards",
    campaign: RewardCampaign | None = None,
) -> RewardClaim:
    """Credits a claim's coins and marks it issued. Safe to repeat (sweep recovery)."""
    expires: Any = wallet.DEFAULT
    if campaign is not None and campaign.coins_expire_at is not None:
        expires = campaign.coins_expire_at  # the campaign's own date wins over the settings
    result = wallet.credit(
        claim.user_id,
        coins=claim.coins,
        source=SOURCE_FOR[RewardType(claim.reward_type)],
        key=f"claim:{claim.claim_key}",
        campaign_id=claim.campaign_id,
        order_id=claim.order_id,
        description=description,
        expires_at=expires,
    )
    RewardClaim.objects.filter(pk=claim.pk, status=ClaimStatus.PENDING).update(
        status=ClaimStatus.ISSUED,
        txn=result.row(),
        issued_at=timezone.now(),
        updated_at=timezone.now(),
    )
    if result.created and title:
        notify(claim.user_id, type="coins.reward", title=title, body=description, link=link)
    return RewardClaim.objects.select_related("campaign").get(pk=claim.pk)


def _grant_once(
    *, user_id: Any, reward_type: str, coins: int, key: str, description: str, title: str
) -> RewardClaim:
    """A one-off reward (welcome, birthday). Idempotent by key."""
    with transaction.atomic():
        claim, _ = RewardClaim.objects.get_or_create(
            claim_key=key,
            defaults={
                "user_id": user_id,
                "reward_type": reward_type,
                "coins": coins,
                "status": ClaimStatus.PENDING,
            },
        )
        if claim.status == ClaimStatus.ISSUED:
            return claim
        return _issue(claim, description=description, title=title)


def welcome_key(user_id: Any) -> str:
    return f"welcome:{user_id}"


def birthday_key(user_id: Any, year: int) -> str:
    return f"birthday:{user_id}:{year}"


def maybe_welcome(user_id: Any, moment: str) -> RewardClaim | None:
    """Called on sign-up and on delivered orders: pays the welcome bonus at the set moment."""
    config = get_reward_config()
    rule = config["welcome"]
    if not rule_on(config, rule) or not rule["coins"] or rule["trigger"] != moment:
        return None
    if RewardClaim.objects.filter(
        claim_key=welcome_key(user_id), status=ClaimStatus.ISSUED
    ).exists():
        return None
    return _grant_once(
        user_id=user_id,
        reward_type=RewardType.WELCOME,
        coins=rule["coins"],
        key=welcome_key(user_id),
        description="Welcome to BiteBox",
        title=f"Welcome! {rule['coins']} coins are in your wallet",
    )


def _is_leap(y: int) -> bool:
    return (y % 4 == 0 and y % 100 != 0) or y % 400 == 0


def _local_today(now: datetime, config: dict[str, Any]) -> date:
    return now.astimezone(ZoneInfo(config["timezone"])).date()


def birthday_sweep(*, now: datetime | None = None, limit: int = 500) -> dict[str, int]:
    """Everyone whose birthday is today (in the configured zone) gets the bonus once a year."""
    now = now or timezone.now()
    config = get_reward_config()
    rule = config["birthday"]
    if not rule_on(config, rule) or not rule["coins"]:
        return {"issued": 0}
    today = _local_today(now, config)
    # 29 February birthdays are celebrated on 28 February in other years.
    days = (
        [28, 29]
        if today.month == 2 and today.day == 28 and not _is_leap(today.year)
        else [today.day]
    )
    users = list(
        User.objects.filter(
            role=Role.CUSTOMER,
            status=UserStatus.ACTIVE,
            birth_date__isnull=False,
            birth_date__month=today.month,
            birth_date__day__in=days,
        ).values_list("pk", flat=True)[:limit]
    )
    done = set(
        RewardClaim.objects.filter(
            claim_key__in=[birthday_key(u, today.year) for u in users], status=ClaimStatus.ISSUED
        ).values_list("claim_key", flat=True)
    )
    issued = 0
    for user_id in users:
        key = birthday_key(user_id, today.year)
        if key in done:
            continue
        try:
            _grant_once(
                user_id=user_id,
                reward_type=RewardType.BIRTHDAY,
                coins=rule["coins"],
                key=key,
                description="Happy birthday from BiteBox",
                title=f"Happy birthday! {rule['coins']} coins are in your wallet",
            )
            issued += 1
        except Exception:
            logger.exception("Birthday reward failed", extra={"user_id": str(user_id)})
    return {"issued": issued}


def set_birth_date(user_id: Any, iso_date: str, now: datetime | None = None) -> dict[str, str]:
    """The customer sets their date of birth, once (support can correct it)."""
    now = now or timezone.now()
    try:
        born = date.fromisoformat(iso_date)
    except ValueError:
        raise _invalid("birthDate", "Enter a valid date") from None
    age = (now.date() - born).days / 365.25
    if age < 13 or age > 120:
        raise ApiError(
            422,
            "Enter your real date of birth",
            code="VALIDATION_ERROR",
            details=[{"field": "birthDate", "message": "Enter your real date of birth"}],
        )
    if not User.objects.filter(pk=user_id, role=Role.CUSTOMER, birth_date__isnull=True).update(
        birth_date=born
    ):
        raise _conflict(
            "Your birthday is already saved. Contact support to change it.", "BIRTHDAY_SET"
        )
    return {"birth_date": iso_date}


# ---------------------------------------------------------------------------
# Campaign eligibility
# ---------------------------------------------------------------------------
def _order_history(user_id: Any, exclude_order_id: Any = None) -> dict[str, Any]:
    """The customer's latest delivered order (optionally ignoring one): all customer groups need."""
    qs = Order.objects.filter(customer_id=user_id, status=OrderStatus.DELIVERED)
    if exclude_order_id:
        qs = qs.exclude(pk=exclude_order_id)
    last = qs.order_by("-created_at").values_list("created_at", flat=True).first()
    return {"ordered": last is not None, "last_at": last}


def _lazy_history(user_id: Any) -> Callable[[], dict[str, Any]]:
    cache: list[dict[str, Any]] = []

    def load() -> dict[str, Any]:
        if not cache:
            cache.append(_order_history(user_id))
        return cache[0]

    return load


def _group_ok(c: RewardCampaign, history: dict[str, Any], now: datetime) -> bool:
    if c.customer_group == G.NEW:
        return not history["ordered"]
    if c.customer_group == G.EXISTING:
        return bool(history["ordered"])
    if c.customer_group == G.INACTIVE:
        return bool(
            history["ordered"] and history["last_at"] < now - timedelta(days=c.inactive_days)
        )
    return True


def _running(c: RewardCampaign, now: datetime) -> bool:
    return c.status == CS.ACTIVE and c.start_at <= now < c.end_at


def _claim_blocker(
    c: RewardCampaign, history: Callable[[], dict[str, Any]], now: datetime, used: int
) -> str | None:
    """Why a customer cannot claim (None when they can). Customer-safe wording."""
    if c.trigger != CampaignTrigger.CLAIM:
        return "Earned automatically with a qualifying order"
    if not _running(c, now):
        return "Not started yet" if c.start_at > now else "This offer has ended"
    if used >= c.max_claims_per_customer:
        return "Already claimed"
    if c.max_total_claims is not None and c.claims_count >= c.max_total_claims:
        return "All rewards have been claimed"
    if c.max_total_coins is not None and c.coins_issued + c.reward_coins > c.max_total_coins:
        return "All rewards have been claimed"
    if c.customer_group != G.ALL and not _group_ok(c, history(), now):
        return GROUP_REASON[G(c.customer_group)]
    return None


def _claim_campaign(
    campaign: RewardCampaign, user_id: Any, *, order_id: Any = None, now: datetime | None = None
) -> RewardClaim | None:
    """
    Takes one claim slot of a campaign for a customer, then pays it. Limits are enforced
    atomically: the counters only move while under their limits, and the per-customer claim
    number is part of the unique claim key.
    """
    now = now or timezone.now()
    if not get_reward_config()["coins_enabled"]:
        raise _conflict("Rewards are paused right now", "REWARDS_PAUSED")
    for _ in range(5):
        used = RewardClaim.objects.filter(campaign=campaign, user_id=user_id).count()
        if used >= campaign.max_claims_per_customer:
            raise _conflict("You have already claimed this reward", "ALREADY_CLAIMED")
        try:
            with transaction.atomic():
                counted = (
                    RewardCampaign.objects.filter(
                        pk=campaign.pk, status=CS.ACTIVE, start_at__lte=now, end_at__gt=now
                    )
                    .filter(
                        Q(max_total_claims__isnull=True) | Q(claims_count__lt=F("max_total_claims"))
                    )
                    .filter(
                        Q(max_total_coins__isnull=True)
                        | Q(coins_issued__lte=F("max_total_coins") - F("reward_coins"))
                    )
                    .update(
                        claims_count=F("claims_count") + 1,
                        coins_issued=F("coins_issued") + F("reward_coins"),
                        updated_at=now,
                    )
                )
                if not counted:
                    raise _conflict("This reward is no longer available", "CAMPAIGN_UNAVAILABLE")
                claim = RewardClaim.objects.create(
                    user_id=user_id,
                    campaign=campaign,
                    reward_type=(
                        RewardType.FESTIVAL
                        if campaign.type == CampaignType.FESTIVAL
                        else RewardType.PROMOTIONAL
                    ),
                    coins=campaign.reward_coins,
                    order_id=order_id,
                    claim_key=f"campaign:{campaign.pk}:{user_id}:{used + 1}",
                    status=ClaimStatus.PENDING,
                )
        except IntegrityError:
            # Lost a race for this slot, or this order already earned this campaign.
            if (
                order_id
                and RewardClaim.objects.filter(campaign=campaign, order_id=order_id).exists()
            ):
                return None
            continue
        _complete_if_full(campaign.pk)
        return _issue(
            claim,
            campaign=campaign,
            description=campaign.name,
            title=f"You earned {campaign.reward_coins} coins",
        )
    raise _conflict("Please try again", "CLAIM_BUSY")


def _complete_if_full(campaign_id: Any) -> None:
    c = RewardCampaign.objects.get(pk=campaign_id)
    claims_full = c.max_total_claims is not None and c.claims_count >= c.max_total_claims
    coins_full = (
        c.max_total_coins is not None and c.coins_issued + c.reward_coins > c.max_total_coins
    )
    if claims_full or coins_full:
        RewardCampaign.objects.filter(pk=c.pk, status=CS.ACTIVE).update(status=CS.COMPLETED)


def claim(user_id: Any, campaign_id: Any, now: datetime | None = None) -> dict[str, Any]:
    """POST /rewards/campaigns/{id}/claim"""
    now = now or timezone.now()
    campaign = RewardCampaign.objects.exclude(status=CS.DRAFT).filter(pk=campaign_id).first()
    if campaign is None:
        raise ApiError.not_found("Reward not found")
    used = RewardClaim.objects.filter(campaign=campaign, user_id=user_id).count()
    blocker = _claim_blocker(campaign, _lazy_history(user_id), now, used)
    if blocker:
        raise _conflict(blocker, "NOT_ELIGIBLE")
    issued = _claim_campaign(campaign, user_id, now=now)
    if issued is None:  # only order campaigns skip a duplicate; claims always pay or raise
        raise _conflict("Please try again", "CLAIM_BUSY")
    return {"claim": claim_view(issued)}


def on_order_delivered(order: Order, now: datetime | None = None) -> list[RewardClaim]:
    """Delivered order: pays every running ORDER campaign it qualifies for (each once per order)."""
    now = now or timezone.now()
    campaigns = list(
        RewardCampaign.objects.filter(
            status=CS.ACTIVE,
            trigger=CampaignTrigger.ORDER,
            start_at__lte=order.created_at,
            end_at__gt=now,
        ).prefetch_related("restaurants")
    )
    if not campaigns:
        return []
    history = _order_history(order.customer_id, order.pk)
    food = food_value_paise(order)
    paid = []
    for c in campaigns:
        restaurants = [r.pk for r in c.restaurants.all()]
        if order.created_at >= c.end_at or food < c.min_order_paise:
            continue
        if c.first_order_only and history["ordered"]:
            continue
        if restaurants and order.restaurant_id not in restaurants:
            continue
        if not _group_ok(c, history, now):
            continue
        try:
            with transaction.atomic():
                claimed = _claim_campaign(c, order.customer_id, order_id=order.pk, now=now)
            if claimed:
                paid.append(claimed)
        except ApiError:
            pass  # limits reached: simply not rewarded
    return paid


# ---------------------------------------------------------------------------
# Sweep: schedules and recovery
# ---------------------------------------------------------------------------
def campaign_sweep(*, now: datetime | None = None, limit: int = 200) -> dict[str, int]:
    now = now or timezone.now()
    started = RewardCampaign.objects.filter(
        status=CS.SCHEDULED, start_at__lte=now, end_at__gt=now
    ).update(status=CS.ACTIVE, updated_at=now)
    ended = RewardCampaign.objects.filter(
        status__in=[CS.SCHEDULED, CS.ACTIVE, CS.PAUSED], end_at__lte=now
    ).update(status=CS.EXPIRED, updated_at=now)
    # Claims a crash left between "claimed" and "credited".
    pending = RewardClaim.objects.filter(
        status=ClaimStatus.PENDING, updated_at__lte=now - timedelta(minutes=5)
    ).select_related("campaign")[:limit]
    recovered = 0
    for c in pending:
        try:
            with transaction.atomic():
                _issue(
                    c,
                    campaign=c.campaign,
                    description=c.campaign.name
                    if c.campaign
                    else f"{c.reward_type.lower()} reward",
                )
            recovered += 1
        except Exception:
            logger.exception("Could not finish a reward claim", extra={"claim_id": str(c.pk)})
    return {"started": started, "ended": ended, "recovered": recovered}


# ---------------------------------------------------------------------------
# Customer views
# ---------------------------------------------------------------------------
def claim_view(c: RewardClaim) -> dict[str, Any]:
    return {
        "id": str(c.pk),
        "reward_type": c.reward_type,
        "coins": c.coins,
        "status": c.status,
        "campaign": {"id": str(c.campaign.pk), "name": c.campaign.name} if c.campaign else None,
        "order_id": str(c.order_id) if c.order_id else None,
        "claimed_at": c.created_at,
    }


def _for_customer(
    c: RewardCampaign, used: int, blocker: str | None, now: datetime
) -> dict[str, Any]:
    return {
        "id": str(c.pk),
        "name": c.name,
        "description": c.description,
        "type": c.type,
        "trigger": c.trigger,
        "reward_coins": c.reward_coins,
        "start_at": c.start_at,
        "end_at": c.end_at,
        "coins_expire_at": c.coins_expire_at,
        "status": CS.SCHEDULED if c.status == CS.ACTIVE and c.start_at > now else c.status,
        "conditions": {
            "min_order_paise": c.min_order_paise,
            "first_order_only": c.first_order_only,
            "restaurant_only": c.restaurants.exists(),
        },
        "claimed_times": used,
        "max_claims_per_customer": c.max_claims_per_customer,
        "can_claim": not blocker,
        "reason": blocker,
    }


def customer_campaigns(user_id: Any, now: datetime | None = None) -> dict[str, Any]:
    """Running and upcoming (next 30 days) campaigns, with what this customer can do."""
    now = now or timezone.now()
    campaigns = list(
        RewardCampaign.objects.filter(
            status__in=[CS.ACTIVE, CS.SCHEDULED],
            end_at__gt=now,
            start_at__lte=now + timedelta(days=30),
        ).order_by("end_at")[:50]
    )
    counts = {
        row["campaign"]: row["n"]
        for row in RewardClaim.objects.filter(user_id=user_id, campaign__in=campaigns)
        .values("campaign")
        .annotate(n=Count("pk"))
        .order_by()
    }
    history = _lazy_history(user_id)
    items = []
    for c in campaigns:
        used = counts.get(c.pk, 0)
        items.append(_for_customer(c, used, _claim_blocker(c, history, now, used), now))
    return {"items": items}


def overview(user_id: Any, now: datetime | None = None) -> dict[str, Any]:
    """The Special Rewards page header: birthday, welcome and totals."""
    now = now or timezone.now()
    config = get_reward_config()
    user = User.objects.filter(pk=user_id).only("birth_date").first()
    totals = RewardClaim.objects.filter(user_id=user_id, status=ClaimStatus.ISSUED).aggregate(
        claims=Count("pk"), coins=Sum("coins")
    )
    welcome = RewardClaim.objects.filter(claim_key=welcome_key(user_id)).first()
    today = _local_today(now, config)
    birthday: dict[str, Any] = {}
    born = user.birth_date if user else None
    if born:
        passed = (born.month, born.day) < (today.month, today.day)
        next_year = today.year + 1 if passed else today.year
        next_day = (
            28 if born.month == 2 and born.day == 29 and not _is_leap(next_year) else born.day
        )
        birthday = {
            "birth_date": born.isoformat(),
            "next": f"{next_year}-{born.month:02d}-{next_day:02d}",
            "claimed_this_year": RewardClaim.objects.filter(
                claim_key=birthday_key(user_id, today.year)
            ).exists(),
        }
    on = config["coins_enabled"]
    return {
        "enabled": on,
        "birthday": {
            "enabled": on and config["birthday"]["enabled"],
            "coins": config["birthday"]["coins"],
            **birthday,
            "saved": bool(birthday),
        },
        "welcome": {
            "enabled": on and config["welcome"]["enabled"],
            "coins": config["welcome"]["coins"],
            "trigger": config["welcome"]["trigger"],
            "claimed": bool(welcome and welcome.status == ClaimStatus.ISSUED),
        },
        "totals": {"claims": totals["claims"] or 0, "coins": totals["coins"] or 0},
    }


def history(user_id: Any, query: dict[str, Any], page: Page) -> dict[str, Any]:
    qs = RewardClaim.objects.filter(user_id=user_id).select_related("campaign")
    if query.get("reward_type"):
        qs = qs.filter(reward_type=query["reward_type"])
    rows, meta = paginate(qs.order_by("-created_at"), page)
    return {"items": [claim_view(c) for c in rows], "pagination": meta}


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
EDITABLE = (
    "name",
    "description",
    "type",
    "trigger",
    "reward_coins",
    "start_at",
    "end_at",
    "coins_expire_at",
    "timezone",
    "conditions",
    "limits",
)
# Running campaigns keep their promise to customers: only wording, the dates and limits change
# (a new coin expiry applies to coins given from then on).
EDITABLE_WHILE_RUNNING = ("name", "description", "end_at", "coins_expire_at", "limits")
CAMEL = {
    "reward_coins": "rewardCoins",
    "start_at": "startAt",
    "end_at": "endAt",
    "coins_expire_at": "coinsExpireAt",
}
CONDITIONS = ("customer_group", "inactive_days", "min_order_paise", "first_order_only")
LIMITS = ("max_claims_per_customer", "max_total_claims", "max_total_coins")


def _check_dates(c: RewardCampaign) -> None:
    """Node: the campaign schema's checkDates (a model rule, so a 422 "Validation failed")."""
    details = []
    if c.end_at <= c.start_at:
        details.append({"field": "endAt", "message": "The end must be after the start"})
    if c.coins_expire_at is not None and c.coins_expire_at <= c.end_at:
        details.append(
            {
                "field": "coinsExpireAt",
                "message": "Coins must stay valid until after the campaign ends",
            }
        )
    if details:
        raise ApiError(422, "Validation failed", code="VALIDATION_ERROR", details=details)


def _apply(c: RewardCampaign, data: dict[str, Any]) -> list[Any] | None:
    """Sets the given fields; returns the restaurant ids to link (None: leave them)."""
    restaurants = None
    for key, value in data.items():
        if key == "conditions":
            for k, v in value.items():
                if k == "restaurants":
                    restaurants = list(v)
                elif k in CONDITIONS:
                    setattr(c, k, v)
        elif key == "limits":
            for k, v in value.items():
                if k in LIMITS:
                    setattr(c, k, v)
        else:
            setattr(c, key, value)
    return restaurants


def _save(c: RewardCampaign, restaurants: list[Any] | None) -> None:
    _check_dates(c)
    with transaction.atomic():
        c.save()
        if restaurants is not None:
            c.restaurants.set(Restaurant.objects.filter(pk__in=restaurants))


def admin_create(admin: User, data: dict[str, Any]) -> dict[str, Any]:
    c = RewardCampaign(status=CS.DRAFT, created_by=admin, updated_by=admin)
    restaurants = _apply(c, {k: v for k, v in data.items() if k in EDITABLE})
    _save(c, restaurants)
    return admin_view(c)


def _get(campaign_id: Any) -> RewardCampaign:
    c = RewardCampaign.objects.filter(pk=campaign_id).first()
    if c is None:
        raise ApiError.not_found("Campaign not found")
    return c


def admin_update(admin: User, campaign_id: Any, data: dict[str, Any]) -> dict[str, Any]:
    c = _get(campaign_id)
    if c.status in (CS.EXPIRED, CS.COMPLETED):
        raise _conflict("Finished campaigns cannot be edited", "CAMPAIGN_FINISHED")
    fields = EDITABLE_WHILE_RUNNING if c.status == CS.ACTIVE else EDITABLE
    blocked = [k for k in data if k in EDITABLE and k not in fields]
    if blocked:
        raise _conflict(
            f"Pause the campaign to change: {', '.join(CAMEL.get(k, k) for k in blocked)}",
            "CAMPAIGN_RUNNING",
        )
    restaurants = _apply(c, {k: v for k, v in data.items() if k in fields})
    c.updated_by = admin
    _save(c, restaurants)
    return admin_view(c)


MOVES = {
    "activate": (CS.DRAFT, CS.PAUSED),
    "pause": (CS.ACTIVE, CS.SCHEDULED),
    "end": (CS.DRAFT, CS.SCHEDULED, CS.ACTIVE, CS.PAUSED),
}


def admin_set_status(
    admin: User, campaign_id: Any, action: str, now: datetime | None = None
) -> dict[str, Any]:
    """activate (→ SCHEDULED or ACTIVE), pause, or end (→ COMPLETED)."""
    now = now or timezone.now()
    c = _get(campaign_id)
    if c.status not in MOVES[action]:
        verb = "ended" if action == "end" else f"{action}d"
        raise _conflict(f"A {c.status.lower()} campaign cannot be {verb}", "INVALID_CAMPAIGN_MOVE")
    if action == "activate":
        if c.end_at <= now:
            raise _conflict("The end date has passed. Change it first.", "CAMPAIGN_ENDED")
        to = CS.SCHEDULED if c.start_at > now else CS.ACTIVE
    else:
        to = CS.PAUSED if action == "pause" else CS.COMPLETED
    if not RewardCampaign.objects.filter(pk=c.pk, status=c.status).update(
        status=to, updated_by=admin, updated_at=now
    ):
        raise _conflict("The campaign was just changed. Refresh and try again.", "CAMPAIGN_CHANGED")
    return admin_view(_get(c.pk))


def admin_view(c: RewardCampaign, restaurants: list[Any] | None = None) -> dict[str, Any]:
    return {
        "id": str(c.pk),
        "name": c.name,
        "description": c.description,
        "type": c.type,
        "trigger": c.trigger,
        "reward_coins": c.reward_coins,
        "start_at": c.start_at,
        "end_at": c.end_at,
        "coins_expire_at": c.coins_expire_at,
        "timezone": c.timezone,
        "status": c.status,
        "conditions": {
            "customer_group": c.customer_group,
            "inactive_days": c.inactive_days,
            "min_order_paise": c.min_order_paise,
            "first_order_only": c.first_order_only,
            "restaurants": (
                restaurants
                if restaurants is not None
                else [str(pk) for pk in c.restaurants.values_list("pk", flat=True)]
            ),
        },
        "limits": {
            "max_claims_per_customer": c.max_claims_per_customer,
            "max_total_claims": c.max_total_claims,
            "max_total_coins": c.max_total_coins,
        },
        "stats": {"claims": c.claims_count, "coins": c.coins_issued},
        "created_by": str(c.created_by_id) if c.created_by_id else None,
        "updated_by": str(c.updated_by_id) if c.updated_by_id else None,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
        "remaining_claims": (
            None if c.max_total_claims is None else max(0, c.max_total_claims - c.claims_count)
        ),
        "remaining_coins": (
            None if c.max_total_coins is None else max(0, c.max_total_coins - c.coins_issued)
        ),
    }


def admin_list(query: dict[str, Any], page: Page) -> dict[str, Any]:
    qs = RewardCampaign.objects.prefetch_related("restaurants")
    if query.get("status"):
        qs = qs.filter(status=query["status"])
    if query.get("type"):
        qs = qs.filter(type=query["type"])
    if query.get("search"):
        qs = qs.filter(name__icontains=query["search"])
    rows, meta = paginate(qs.order_by("-created_at"), page)
    return {"items": [admin_view(c) for c in rows], "pagination": meta}


def admin_get(campaign_id: Any) -> dict[str, Any]:
    c = _get(campaign_id)
    restaurants = [{"id": str(r.pk), "name": r.name, "slug": r.slug} for r in c.restaurants.all()]
    recent = (
        RewardClaim.objects.filter(campaign=c).select_related("user").order_by("-created_at")[:20]
    )
    customers = RewardClaim.objects.filter(campaign=c).values("user").distinct().count()
    return {
        "campaign": admin_view(c, restaurants),
        "performance": {"claims": c.claims_count, "coins": c.coins_issued, "customers": customers},
        "recent_claims": [
            {
                "id": str(r.pk),
                "customer": person(r.user),
                "coins": r.coins,
                "status": r.status,
                "order_id": str(r.order_id) if r.order_id else None,
                "claimed_at": r.created_at,
            }
            for r in recent
        ],
    }


def admin_claims(query: dict[str, Any], page: Page) -> dict[str, Any]:
    """Every reward claim (welcome, birthday, campaigns), newest first."""
    qs = RewardClaim.objects.select_related("user", "campaign")
    if query.get("reward_type"):
        qs = qs.filter(reward_type=query["reward_type"])
    if query.get("campaign"):
        qs = qs.filter(campaign_id=query["campaign"])
    rows, meta = paginate(qs.order_by("-created_at"), page)
    return {
        "items": [{**claim_view(c), "customer": person(c.user)} for c in rows],
        "pagination": meta,
    }
