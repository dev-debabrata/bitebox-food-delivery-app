"""
Refer & earn (Node: services/referral.service.js). A customer shares their code; a friend signs up
with it (REGISTERED), places a first order (FIRST_ORDER_PLACED) and has it delivered within the
attribution window (ORDER_DELIVERED). Then both are rewarded (REWARD_CREDITED), unless a risk
signal holds it for an admin. Everything is decided here from server data; the client only ever
sends the code.
"""

import logging
import secrets
import unicodedata
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Count, Q, Sum
from django.utils import timezone

from apps.accounts.models import Session, User, UserStatus
from apps.customers.models import Address
from apps.notifications.services import notify, notify_admins
from apps.orders.models import Order, OrderStatus
from apps.rbac.roles import Permission, Role
from common.api import ApiError
from common.geo import GeoPoint, haversine_m
from common.pagination import Page, paginate

from . import wallet
from .models import (
    Referral,
    ReferralEvent,
    ReferralRewardCounter,
    ReferralRewardStatus,
    ReferralRisk,
    ReferralStatus,
)
from .orders import food_value_paise
from .quote import get_reward_config, rule_on

logger = logging.getLogger("bitebox.coins")

R = ReferralStatus
RS = ReferralRewardStatus
SAME_PLACE_METERS = 100  # delivery points closer than this count as "the same address"
VELOCITY_PER_DAY = 5  # more sign-ups than this with one code in a day is unusual
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O or 1/I
CODE_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-")


def invalid_code(message: str = "This referral code is not valid") -> ApiError:
    return ApiError(
        422,
        message,
        code="REFERRAL_INVALID",
        details=[{"field": "referralCode", "message": message}],
    )


def _reward_key(referral_id: Any, who: str) -> str:
    return f"referral:{referral_id}:{who}"


def referral_link(code: str) -> str:
    return f"{settings.CLIENT_URLS[0]}/register?ref={quote(code, safe='')}"


def normalise(code: Any) -> str:
    return str(code or "").strip().upper()


def generate_code(name: str | None) -> str:
    """BITEBOX-RIYA7K2Q: up to 5 letters of the first name plus 4 random characters."""
    words = unicodedata.normalize("NFKD", str(name or "")).upper().split()
    letters = "".join(c for c in (words[0] if words else "") if "A" <= c <= "Z")[:5] or "FRIEND"
    return f"BITEBOX-{letters}{''.join(secrets.choice(ALPHABET) for _ in range(4))}"


def ensure_referral_code(user_id: Any) -> str:
    """The customer's code, created on first use. Unique in the database (retries on a clash)."""
    user = User.objects.filter(pk=user_id).only("name", "role", "referral_code").first()
    if user is None:
        raise ApiError.not_found("Account not found")
    if user.referral_code:
        return user.referral_code
    if user.role != Role.CUSTOMER:
        raise ApiError.forbidden("Only customers can refer friends")
    for _ in range(8):
        try:
            with transaction.atomic():
                User.objects.filter(pk=user.pk, referral_code__isnull=True).update(
                    referral_code=generate_code(user.name)
                )
            break
        except IntegrityError:  # code taken: try another
            continue
    saved = User.objects.filter(pk=user.pk).values_list("referral_code", flat=True).first()
    if not saved:
        raise RuntimeError("Could not create a referral code")
    return saved


def resolve_code(raw_code: Any, config: dict[str, Any] | None = None) -> dict[str, Any]:
    """The referrer behind a code, if the code can be used now. 422 REFERRAL_INVALID otherwise."""
    code = normalise(raw_code)
    if not 4 <= len(code) <= 40 or not set(code) <= CODE_CHARS:
        raise invalid_code()
    settings_ = config or get_reward_config()
    if not rule_on(settings_, settings_["referral"]):
        raise invalid_code("Referrals are paused right now. You can still sign up without a code.")
    referrer = User.objects.filter(referral_code=code).first()
    if referrer is None or referrer.role != Role.CUSTOMER or referrer.status != UserStatus.ACTIVE:
        raise invalid_code()
    used = Referral.objects.filter(referrer=referrer).count()
    if used >= settings_["referral"]["max_referrals_per_customer"]:
        raise invalid_code("This referral code can no longer be used")
    return {"referrer": referrer, "code": code}


def validate_code(raw_code: Any) -> dict[str, Any]:
    """Public check for the sign-up form: only says whether a code works (never whose it is)."""
    try:
        resolve_code(raw_code)
        return {"valid": True}
    except ApiError as error:
        if error.code == "REFERRAL_INVALID":
            return {"valid": False, "message": error.message}
        raise


def _event(referral_id: Any, status: str, note: str = "") -> None:
    ReferralEvent.objects.create(referral_id=referral_id, status=status, note=note[:200])


def record_signup(
    user: User, resolved: dict[str, Any], *, ip: str | None = None, now: datetime | None = None
) -> Referral:
    """A customer signed up with a code `resolve_code` accepted. Records the relationship once."""
    referrer = resolved["referrer"]
    if str(referrer.pk) == str(user.pk):
        raise invalid_code("You cannot use your own code")
    now = now or timezone.now()
    config = get_reward_config()
    try:
        with transaction.atomic():
            referral = Referral.objects.create(
                referrer=referrer,
                referred=user,
                code=resolved["code"],
                status=R.REGISTERED,
                attribution_expires_at=now + timedelta(days=config["referral"]["attribution_days"]),
                signup_ip=ip or None,
            )
            _event(referral.pk, R.REGISTERED)
            return referral
    except IntegrityError:  # one referrer only
        return Referral.objects.get(referred=user)


# ---------------------------------------------------------------------------
# Order events
# ---------------------------------------------------------------------------
def on_order_placed(order: Order, now: datetime | None = None) -> None:
    """The referred friend placed an order: it becomes their candidate first order."""
    now = now or timezone.now()
    referral = Referral.objects.filter(
        referred_id=order.customer_id, status=R.REGISTERED, attribution_expires_at__gt=now
    ).first()
    if referral and Referral.objects.filter(pk=referral.pk, status=R.REGISTERED).update(
        status=R.FIRST_ORDER_PLACED, qualifying_order=order, updated_at=now
    ):
        _event(referral.pk, R.FIRST_ORDER_PLACED, f"Order {order.order_number}")


def on_order_closed(order: Order, now: datetime | None = None) -> None:
    """That order was cancelled or rejected: wait for another one (or expire)."""
    now = now or timezone.now()
    referral = Referral.objects.filter(
        referred_id=order.customer_id, status=R.FIRST_ORDER_PLACED, qualifying_order=order
    ).first()
    if referral is None:
        return
    to = R.EXPIRED if referral.attribution_expires_at <= now else R.REGISTERED
    if Referral.objects.filter(
        pk=referral.pk, status=R.FIRST_ORDER_PLACED, qualifying_order=order
    ).update(status=to, qualifying_order=None, updated_at=now):
        _event(referral.pk, to, f"Order {order.order_number} was {order.status}")


def _risk_flags(referral: Referral, order: Order) -> list[str]:
    """Signals worth a human look. Uses only server data."""
    point: GeoPoint | None = order.delivery_location

    def near(other: GeoPoint | None) -> bool:
        return bool(point and other and haversine_m(point, other) <= SAME_PLACE_METERS)

    same_ip = bool(
        referral.signup_ip
        and Session.objects.filter(user_id=referral.referrer_id, ip=referral.signup_ip).exists()
    )
    addresses = Address.objects.filter(user_id=referral.referrer_id).values_list(
        "location", flat=True
    )
    referrer_orders = (
        Order.objects.filter(customer_id=referral.referrer_id, status=OrderStatus.DELIVERED)
        .order_by("-created_at")
        .values_list("delivery_location", flat=True)[:20]
    )
    sibling_ids = (
        Referral.objects.filter(referrer_id=referral.referrer_id, qualifying_order__isnull=False)
        .exclude(pk=referral.pk)
        .values_list("qualifying_order_id", flat=True)[:50]
    )
    siblings = Order.objects.filter(pk__in=list(sibling_ids)).values_list(
        "delivery_location", flat=True
    )
    burst = Referral.objects.filter(
        referrer_id=referral.referrer_id,
        created_at__gte=referral.created_at - timedelta(days=1),
        created_at__lte=referral.created_at,
    ).count()
    flags = []
    if same_ip:
        flags.append(ReferralRisk.SAME_SIGNUP_IP.value)
    if any(near(a) for a in addresses) or any(near(o) for o in referrer_orders):
        flags.append(ReferralRisk.ADDRESS_MATCHES_REFERRER.value)
    if any(near(o) for o in siblings):
        flags.append(ReferralRisk.ADDRESS_SHARED_WITH_OTHER_REFERRAL.value)
    if burst > VELOCITY_PER_DAY:
        flags.append(ReferralRisk.REFERRER_VELOCITY.value)
    return flags


def on_order_delivered(order: Order, now: datetime | None = None) -> Referral | None:
    """The friend's order was delivered: qualify the referral and reward it (or hold it)."""
    now = now or timezone.now()
    referral = Referral.objects.filter(
        referred_id=order.customer_id, status__in=[R.REGISTERED, R.FIRST_ORDER_PLACED]
    ).first()
    if referral is None:
        return None
    config = get_reward_config()
    if not rule_on(config, config["referral"]):
        return None

    if order.created_at > referral.attribution_expires_at:  # ordered after the window closed
        if Referral.objects.filter(pk=referral.pk, status=referral.status).update(
            status=R.EXPIRED, qualifying_order=None, updated_at=now
        ):
            _event(referral.pk, R.EXPIRED, "First order came after the referral window")
        return None
    if food_value_paise(order) < config["referral"]["min_order_paise"]:
        # Too small to qualify: keep waiting for a bigger first order.
        if (
            referral.status == R.FIRST_ORDER_PLACED
            and referral.qualifying_order_id == order.pk
            and Referral.objects.filter(pk=referral.pk, status=R.FIRST_ORDER_PLACED).update(
                status=R.REGISTERED, qualifying_order=None, updated_at=now
            )
        ):
            _event(referral.pk, R.REGISTERED, f"Order {order.order_number} was below the minimum")
        return None

    # Exactly one delivered order qualifies.
    if not Referral.objects.filter(
        pk=referral.pk, status__in=[R.REGISTERED, R.FIRST_ORDER_PLACED]
    ).update(
        status=R.ORDER_DELIVERED,
        qualifying_order=order,
        reward_status=RS.CREDITING,
        updated_at=now,
    ):
        return None
    _event(referral.pk, R.ORDER_DELIVERED, f"Order {order.order_number} delivered")
    qualified = Referral.objects.get(pk=referral.pk)

    flags = _risk_flags(qualified, order)
    if flags:
        Referral.objects.filter(pk=qualified.pk, reward_status=RS.CREDITING).update(
            reward_status=RS.HELD, risk_flags=flags, updated_at=now
        )
        logger.warning(
            "Referral held for review", extra={"referral_id": str(qualified.pk), "flags": flags}
        )
        notify_admins(
            Permission.REWARDS_MANAGE,
            type="referral.held",
            title="A referral needs review",
            body=f"Code {qualified.code}: {len(flags)} risk signal(s)",
            link="/admin/rewards/referrals",
        )
        return Referral.objects.get(pk=qualified.pk)
    return credit_referral(qualified.pk, now=now)


def _claim_referrer_slot(referral: Referral, config: dict[str, Any], now: datetime) -> bool:
    """Claims one of the referrer's monthly reward slots. False when the month is full."""
    if referral.referrer_slot:
        return True  # claimed by an earlier attempt
    period = now.astimezone(ZoneInfo(config["timezone"])).strftime("%Y-%m")
    with transaction.atomic():
        counter, _ = ReferralRewardCounter.objects.select_for_update().get_or_create(
            referrer_id=referral.referrer_id, period=period
        )
        if counter.count >= config["referral"]["max_rewards_per_month"]:
            return False
        counter.count += 1
        counter.save(update_fields=["count", "updated_at"])
        Referral.objects.filter(pk=referral.pk).update(referrer_slot=period)
    return True


def _first_name(user: User | None) -> str:
    parts = (user.name if user else "").split()
    return parts[0] if parts else "Your friend"


def credit_referral(referral_id: Any, *, now: datetime | None = None) -> Referral | None:
    """
    Pays a qualified referral: the friend and (within the monthly limit) the referrer. Idempotent:
    ledger keys per side; the referrer's monthly slot is remembered on the referral.
    """
    now = now or timezone.now()
    referral = Referral.objects.filter(pk=referral_id).first()
    if referral is None or referral.status != R.ORDER_DELIVERED:
        return referral
    if referral.reward_status != RS.CREDITING:
        return referral
    config = get_reward_config()
    referrer_coins = config["referral"]["referrer_coins"]
    referred_coins = config["referral"]["referred_coins"]
    friend = User.objects.filter(pk=referral.referred_id).first()
    inviter = User.objects.filter(pk=referral.referrer_id).first()

    paid_referred = 0
    if referred_coins > 0:
        result = wallet.credit(
            referral.referred_id,
            coins=referred_coins,
            source="REFERRAL_REWARD",
            key=_reward_key(referral.pk, "referred"),
            referral_id=referral.pk,
            order_id=referral.qualifying_order_id,
            description="Referral bonus for your first order",
        )
        paid_referred = result.txn.coins if result.txn else 0
    paid_referrer = 0
    active = inviter is not None and inviter.status == UserStatus.ACTIVE
    if referrer_coins > 0 and active and _claim_referrer_slot(referral, config, now):
        result = wallet.credit(
            referral.referrer_id,
            coins=referrer_coins,
            source="REFERRAL_REWARD",
            key=_reward_key(referral.pk, "referrer"),
            referral_id=referral.pk,
            description=f"{_first_name(friend)} joined with your code",
        )
        paid_referrer = result.txn.coins if result.txn else 0

    partial = referrer_coins > 0 and paid_referrer == 0
    updated = Referral.objects.filter(pk=referral.pk, reward_status=RS.CREDITING).update(
        status=R.REWARD_CREDITED,
        reward_status=RS.PARTIAL if partial else RS.CREDITED,
        referrer_coins=paid_referrer,
        referred_coins=paid_referred,
        rewarded_at=now,
        updated_at=now,
    )
    if updated:
        _event(
            referral.pk,
            R.REWARD_CREDITED,
            "Friend rewarded; referrer limit reached" if partial else "Both rewarded",
        )
        if paid_referred:
            notify(
                referral.referred_id,
                type="coins.referral",
                title=f"You earned {paid_referred} referral coins",
                body="Thanks for ordering with BiteBox",
                link="/account/coins",
            )
        if paid_referrer:
            notify(
                referral.referrer_id,
                type="coins.referral",
                title=f"You earned {paid_referrer} coins",
                body=f"{_first_name(friend)} completed their first order",
                link="/account/refer",
            )
    return Referral.objects.get(pk=referral.pk)


def referral_sweep(*, now: datetime | None = None, limit: int = 200) -> dict[str, int]:
    """Rewards sweep: expire unused referrals and finish rewards a crash left half-paid."""
    now = now or timezone.now()
    due = Referral.objects.filter(status=R.REGISTERED, attribution_expires_at__lte=now)
    ids = list(due.values_list("pk", flat=True))
    expired = Referral.objects.filter(pk__in=ids, status=R.REGISTERED).update(
        status=R.EXPIRED, updated_at=now
    )
    ReferralEvent.objects.bulk_create(
        [
            ReferralEvent(referral_id=i, status=R.EXPIRED, note="No qualifying order in time")
            for i in ids
        ]
    )
    stuck = Referral.objects.filter(
        status=R.ORDER_DELIVERED,
        reward_status=RS.CREDITING,
        updated_at__lte=now - timedelta(minutes=5),
    ).values_list("pk", flat=True)[:limit]
    finished = 0
    for referral_id in list(stuck):
        try:
            with transaction.atomic():
                credit_referral(referral_id, now=now)
            finished += 1
        except Exception:
            logger.exception(
                "Could not finish a referral reward", extra={"referral_id": str(referral_id)}
            )
    return {"expired": expired, "finished": finished}


# ---------------------------------------------------------------------------
# Customer views
# ---------------------------------------------------------------------------
def mask_name(name: str | None) -> str:
    """ "Riya S.": friends are never shown with full names, emails or phones."""
    parts = str(name or "").split()
    if not parts:
        return "Friend"
    return f"{parts[0]} {parts[-1][0].upper()}." if len(parts) > 1 else parts[0]


def customer_status(status: str) -> str:
    """Held and rejected referrals look the same to customers: "not eligible", without reasons."""
    return "NOT_ELIGIBLE" if status == R.REJECTED else status


def _rules(config: dict[str, Any]) -> dict[str, Any]:
    r = config["referral"]
    return {
        "enabled": rule_on(config, r),
        "referrer_coins": r["referrer_coins"],
        "referred_coins": r["referred_coins"],
        "min_order_paise": r["min_order_paise"],
        "attribution_days": r["attribution_days"],
        "max_referrals": r["max_referrals_per_customer"],
    }


def my_referral(user_id: Any) -> dict[str, Any]:
    code = ensure_referral_code(user_id)
    config = get_reward_config()
    counts = {
        row["status"]: row
        for row in Referral.objects.filter(referrer_id=user_id)
        .values("status")
        .annotate(n=Count("pk"), coins=Sum("referrer_coins"))
        .order_by()
    }

    def n(*statuses: str) -> int:
        return sum(counts[s]["n"] for s in statuses if s in counts)

    invited = sum(row["n"] for row in counts.values())
    mine = Referral.objects.filter(referred_id=user_id).first()
    return {
        "code": code,
        "link": referral_link(code),
        "rules": _rules(config),
        "stats": {
            "invited": invited,
            "pending": n(R.REGISTERED, R.FIRST_ORDER_PLACED, R.ORDER_DELIVERED),
            "successful": n(R.REWARD_CREDITED),
            "unsuccessful": n(R.EXPIRED, R.REJECTED),
            "coins_earned": sum(row["coins"] or 0 for row in counts.values()),
            "remaining": max(0, config["referral"]["max_referrals_per_customer"] - invited),
        },
        "referred_by": (
            {
                "status": customer_status(mine.status),
                "coins": mine.referred_coins,
                "expires_at": mine.attribution_expires_at,
            }
            if mine
            else None
        ),
    }


def my_referral_history(user_id: Any, query: dict[str, Any], page: Page) -> dict[str, Any]:
    qs = Referral.objects.filter(referrer_id=user_id).select_related("referred")
    status = query.get("status")
    if status:
        qs = qs.filter(status=R.REJECTED if status == "NOT_ELIGIBLE" else status)
    rows, meta = paginate(qs.order_by("-created_at"), page)
    return {
        "items": [
            {
                "id": str(r.pk),
                "friend": mask_name(r.referred.name),
                "status": customer_status(r.status),
                "coins": r.referrer_coins,
                "joined_at": r.created_at,
                "expires_at": r.attribution_expires_at,
                "rewarded_at": r.rewarded_at,
            }
            for r in rows
        ],
        "pagination": meta,
    }


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
def person(user: User | None) -> dict[str, Any] | None:
    """{id, name, email} for staff views, or None for a missing account."""
    return {"id": str(user.pk), "name": user.name, "email": user.email} if user else None


def matching_user_ids(search: str, fields: tuple[str, ...] = ("phone",)) -> list[Any]:
    """Accounts whose name, email or one of `fields` contains `search` (at most 200)."""
    match = Q()
    for f in ("name", "email", *fields):
        match |= Q(**{f"{f}__icontains": search})
    return list(User.objects.filter(match).values_list("pk", flat=True)[:200])


def admin_view(r: Referral) -> dict[str, Any]:
    order = r.qualifying_order
    data: dict[str, Any] = {
        "id": str(r.pk),
        "referrer": person(r.referrer),
        "referred": person(r.referred),
        "code": r.code,
        "status": r.status,
        "qualifying_order": (
            {"id": str(order.pk), "order_number": order.order_number, "status": order.status}
            if order
            else None
        ),
        "attribution_expires_at": r.attribution_expires_at,
        "referrer_coins": r.referrer_coins,
        "referred_coins": r.referred_coins,
        "reward_status": r.reward_status,
        "referrer_slot": r.referrer_slot,
        "rewarded_at": r.rewarded_at,
        "risk_flags": list(r.risk_flags or []),
        "history": [
            {"status": e.status, "at": e.created_at, **({"note": e.note} if e.note else {})}
            for e in r.history.all()
        ],
        "created_at": r.created_at,
        "updated_at": r.updated_at,
    }
    if r.decision_at:
        data["decision"] = {
            "by": str(r.decision_by_id) if r.decision_by_id else None,
            **({"note": r.decision_note} if r.decision_note else {}),
            "at": r.decision_at,
        }
    return data


def _admin_qs() -> Any:
    return Referral.objects.select_related(
        "referrer", "referred", "qualifying_order"
    ).prefetch_related("history")


def admin_list(query: dict[str, Any], page: Page) -> dict[str, Any]:
    qs = _admin_qs()
    if query.get("status"):
        qs = qs.filter(status=query["status"])
    if query.get("reward_status"):
        qs = qs.filter(reward_status=query["reward_status"])
    if query.get("flagged"):
        qs = qs.exclude(risk_flags=[])
    search = query.get("search")
    if search:
        ids = matching_user_ids(search, ("referral_code",))
        qs = qs.filter(Q(referrer_id__in=ids) | Q(referred_id__in=ids) | Q(code__icontains=search))
    rows, meta = paginate(qs.order_by("-created_at"), page)
    counts = Referral.objects.values("reward_status").annotate(n=Count("pk")).order_by()
    return {
        "items": [admin_view(r) for r in rows],
        "pagination": meta,
        "counts": {c["reward_status"]: c["n"] for c in counts},
    }


def admin_get(referral_id: Any) -> dict[str, Any]:
    referral = _admin_qs().filter(pk=referral_id).first()
    if referral is None:
        raise ApiError.not_found("Referral not found")
    return admin_view(referral)


def approve(admin: User, referral_id: Any, note: str | None) -> dict[str, Any]:
    """An admin approves a held referral: it is paid like any other."""
    now = timezone.now()
    with transaction.atomic():
        held = Referral.objects.filter(
            pk=referral_id, status=R.ORDER_DELIVERED, reward_status=RS.HELD
        ).update(
            reward_status=RS.CREDITING,
            decision_by=admin,
            decision_note=(note or "")[:300],
            decision_at=now,
            updated_at=now,
        )
        if not held:
            raise ApiError.conflict("Only referrals held for review can be approved", "NOT_HELD")
        credit_referral(referral_id)
    return admin_get(referral_id)


def reject(admin: User, referral_id: Any, note: str) -> dict[str, Any]:
    """An admin rejects a referral that has not been paid."""
    now = timezone.now()
    with transaction.atomic():
        updated = Referral.objects.filter(
            pk=referral_id,
            status__in=[R.REGISTERED, R.FIRST_ORDER_PLACED, R.ORDER_DELIVERED],
            reward_status__in=[RS.NONE, RS.HELD],
        ).update(
            status=R.REJECTED,
            reward_status=RS.REJECTED,
            decision_by=admin,
            decision_note=(note or "")[:300],
            decision_at=now,
            updated_at=now,
        )
        if not updated:
            raise ApiError.conflict("This referral can no longer be rejected", "NOT_REJECTABLE")
        _event(referral_id, R.REJECTED, "Rejected after review")
    return admin_get(referral_id)


def stats() -> dict[str, Any]:
    """Totals for the admin reports."""
    by_status = {
        row["status"]: row["n"]
        for row in Referral.objects.values("status").annotate(n=Count("pk")).order_by()
    }
    sums = Referral.objects.aggregate(
        referrer=Sum("referrer_coins"),
        referred=Sum("referred_coins"),
        held=Count("pk", filter=Q(reward_status=RS.HELD)),
        flagged=Count("pk", filter=~Q(risk_flags=[])),
    )
    return {
        "by_status": by_status,
        "total": sum(by_status.values()),
        "coins_paid": (sums["referrer"] or 0) + (sums["referred"] or 0),
        "held": sums["held"] or 0,
        "flagged": sums["flagged"] or 0,
    }
