"""
Coins, referrals and special rewards (Node: coin-wallet, coin-transaction, referral,
reward-campaign and reward-configuration models; design in docs/COINS_REWARDS_PLAN.md).

Only the wallet service (Phase 9) changes wallets, always with a deterministic idempotency key.
Ledger rows are immutable: the one change allowed is a transaction moving from `pending` to
`posted`. That is enforced here (model and queryset) and, on PostgreSQL, by a trigger.
Coins are integers and are never money: they don't mix with payments, payouts or earnings.
"""

from typing import Any

from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models

from apps.orders.models import Order
from apps.restaurants.models import Restaurant
from common.models import AppendOnlyModel, BaseModel, non_negative, one_of

MAX_COINS_PER_OPERATION = 10_000_000
MAX_REWARD_COINS = 1_000_000


class LedgerImmutable(Exception):
    """Raised on any attempt to edit or delete a posted ledger row."""

    code = "LEDGER_IMMUTABLE"


class TxnType(models.TextChoices):
    CREDIT = "CREDIT"  # earned: available += c
    DEBIT = "DEBIT"  # reservation spent: reserved -= c
    RESERVE = "RESERVE"  # held for an order: available -= c, reserved += c
    RELEASE = "RELEASE"  # hold given back: reserved -= c, available += c
    EXPIRE = "EXPIRE"  # batch expired: available -= c
    REVERSAL = "REVERSAL"  # reward clawed back, or a spent redemption refunded


class ReversalOf(models.TextChoices):
    CREDIT = "credit"
    REDEMPTION = "redemption"


class CoinSource(models.TextChoices):
    ORDER_REWARD = "ORDER_REWARD"
    REVIEW_REWARD = "REVIEW_REWARD"
    REFERRAL_REWARD = "REFERRAL_REWARD"
    WELCOME_REWARD = "WELCOME_REWARD"
    BIRTHDAY_REWARD = "BIRTHDAY_REWARD"
    FESTIVAL_REWARD = "FESTIVAL_REWARD"
    PROMOTIONAL_REWARD = "PROMOTIONAL_REWARD"
    COIN_REDEMPTION = "COIN_REDEMPTION"
    COIN_EXPIRY = "COIN_EXPIRY"
    REWARD_REVERSAL = "REWARD_REVERSAL"


EARN_SOURCES = (
    CoinSource.ORDER_REWARD,
    CoinSource.REVIEW_REWARD,
    CoinSource.REFERRAL_REWARD,
    CoinSource.WELCOME_REWARD,
    CoinSource.BIRTHDAY_REWARD,
    CoinSource.FESTIVAL_REWARD,
    CoinSource.PROMOTIONAL_REWARD,
)
EARN_SOURCE_CHOICES = [(s.value, s.label) for s in EARN_SOURCES]


class LedgerStatus(models.TextChoices):
    PENDING = "pending"
    POSTED = "posted"


class CoinWallet(BaseModel):
    """Balances (a cache of the ledger, always changed in the same transaction as a ledger row)."""

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="coin_wallet"
    )
    available = models.PositiveBigIntegerField(default=0)
    reserved = models.PositiveBigIntegerField(default=0)
    total_earned = models.PositiveBigIntegerField(default=0)
    total_redeemed = models.PositiveBigIntegerField(default=0)
    total_expired = models.PositiveBigIntegerField(default=0)
    total_reversed = models.PositiveBigIntegerField(default=0)
    # Coins clawed back that the customer had already spent; taken from future credits.
    uncollected_reversal = models.PositiveBigIntegerField(default=0)
    seq = models.PositiveBigIntegerField(default=0)  # the last ledger row's number

    class Meta:
        db_table = "coin_wallets"


class LedgerQuerySet(models.QuerySet["CoinTransaction"]):
    def delete(self) -> Any:
        raise LedgerImmutable("Ledger rows cannot be deleted")

    def update(self, **kwargs: Any) -> int:
        if (
            set(kwargs) <= {"status", "posted_at"}
            and kwargs.get("status", LedgerStatus.POSTED) == LedgerStatus.POSTED
        ):
            return super().filter(status=LedgerStatus.PENDING).update(**kwargs)
        raise LedgerImmutable("Ledger rows cannot be edited")


class CoinTransaction(AppendOnlyModel):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="coin_transactions"
    )
    wallet = models.ForeignKey(CoinWallet, on_delete=models.PROTECT, related_name="transactions")
    seq = models.PositiveBigIntegerField(validators=[MinValueValidator(1)])
    type = models.CharField(max_length=10, choices=TxnType.choices)
    source = models.CharField(max_length=20, choices=CoinSource.choices)
    reversal_of = models.CharField(max_length=10, choices=ReversalOf.choices, null=True, blank=True)
    coins = models.PositiveBigIntegerField()
    requested_coins = models.PositiveBigIntegerField(null=True, blank=True)
    shortfall = models.PositiveBigIntegerField(null=True, blank=True)
    available_before = models.BigIntegerField()
    available_after = models.BigIntegerField()
    reserved_before = models.BigIntegerField()
    reserved_after = models.BigIntegerField()
    expires_at = models.DateTimeField(null=True, blank=True)  # CREDIT: when this batch expires
    order = models.ForeignKey(
        Order, on_delete=models.PROTECT, null=True, blank=True, related_name="coin_transactions"
    )
    campaign = models.ForeignKey(
        "RewardCampaign", on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    referral = models.ForeignKey(
        "Referral", on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    related_txn = models.ForeignKey(
        "self", on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    # Deterministic, e.g. "order-reward:<orderId>": a retried operation finds its earlier row.
    idempotency_key = models.CharField(max_length=200, unique=True)
    description = models.CharField(max_length=300, blank=True, default="")
    note = models.CharField(
        max_length=500, blank=True, default=""
    )  # admin note on manual reversals
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    status = models.CharField(
        max_length=8, choices=LedgerStatus.choices, default=LedgerStatus.PENDING
    )
    posted_at = models.DateTimeField(null=True, blank=True)

    objects = LedgerQuerySet.as_manager()

    class Meta:
        db_table = "coin_transactions"
        constraints = [
            models.UniqueConstraint(fields=["wallet", "seq"], name="coin_transactions_wallet_seq"),
            one_of("type", TxnType, "coin_transactions_type_valid"),
            one_of("source", CoinSource, "coin_transactions_source_valid"),
            one_of("status", LedgerStatus, "coin_transactions_status_valid"),
            models.CheckConstraint(
                condition=models.Q(available_after__gte=0, reserved_after__gte=0),
                name="coin_transactions_balances_non_negative",
            ),
            models.CheckConstraint(
                condition=models.Q(coins__lte=MAX_COINS_PER_OPERATION),
                name="coin_transactions_coins_limit",
            ),
        ]
        indexes = [
            models.Index(fields=["user", "-seq"], name="coin_txn_user_recent"),
            models.Index(fields=["user", "type", "source", "-seq"], name="coin_txn_user_type"),
            models.Index(fields=["related_txn", "type"], name="coin_txn_related"),
            models.Index(fields=["order"], name="coin_txn_order"),
            models.Index(fields=["type", "source", "-created_at"], name="coin_txn_reports"),
            models.Index(
                fields=["created_at"], condition=models.Q(status="pending"), name="coin_txn_pending"
            ),
        ]

    def save(self, *args: Any, **kwargs: Any) -> None:
        if not self._state.adding:
            fields = set(kwargs.get("update_fields") or ())
            if (
                not fields
                or not fields <= {"status", "posted_at"}
                or self.status != LedgerStatus.POSTED
            ):
                raise LedgerImmutable("Ledger rows cannot be edited (only pending → posted)")
        super().save(*args, **kwargs)

    def delete(self, *args: Any, **kwargs: Any) -> Any:
        raise LedgerImmutable("Ledger rows cannot be deleted")


class CoinBatch(BaseModel):
    """Coins from one credit, spent first-in-first-out and expiring together."""

    wallet = models.ForeignKey(CoinWallet, on_delete=models.PROTECT, related_name="batches")
    origin = models.OneToOneField(CoinTransaction, on_delete=models.PROTECT, related_name="batch")
    source = models.CharField(max_length=20, choices=EARN_SOURCE_CHOICES)
    original = models.PositiveBigIntegerField(validators=[MinValueValidator(1)])
    remaining = models.PositiveBigIntegerField()
    earned_at = models.DateTimeField()
    expires_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "coin_batches"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(original__gte=1, remaining__lte=models.F("original")),
                name="coin_batches_remaining",
            ),
            models.CheckConstraint(
                condition=models.Q(source__in=[s.value for s in EARN_SOURCES]),
                name="coin_batches_source_earning",
            ),
        ]
        indexes = [
            models.Index(fields=["wallet", "expires_at", "earned_at"], name="coin_batches_fifo"),
            models.Index(
                fields=["expires_at"],
                condition=models.Q(remaining__gt=0),
                name="coin_batches_expiring",
            ),
        ]


class AllocationQuerySet(models.QuerySet["CoinAllocation"]):
    def delete(self) -> Any:
        raise LedgerImmutable("Ledger rows cannot be deleted")

    def update(self, **kwargs: Any) -> int:
        raise LedgerImmutable("Ledger rows cannot be edited")


class CoinAllocation(AppendOnlyModel):
    """Which batches a debit, expiry or reversal drew its coins from (immutable)."""

    transaction = models.ForeignKey(
        CoinTransaction, on_delete=models.PROTECT, related_name="allocations"
    )
    batch = models.ForeignKey(CoinBatch, on_delete=models.PROTECT, related_name="allocations")
    source = models.CharField(max_length=20, choices=EARN_SOURCE_CHOICES)
    earned_at = models.DateTimeField()
    expires_at = models.DateTimeField(null=True, blank=True)
    coins = models.PositiveBigIntegerField(validators=[MinValueValidator(1)])

    objects = AllocationQuerySet.as_manager()

    class Meta:
        db_table = "coin_allocations"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(coins__gte=1), name="coin_allocations_positive"
            )
        ]

    def save(self, *args: Any, **kwargs: Any) -> None:
        if not self._state.adding:
            raise LedgerImmutable("Ledger rows cannot be edited")
        super().save(*args, **kwargs)

    def delete(self, *args: Any, **kwargs: Any) -> Any:
        raise LedgerImmutable("Ledger rows cannot be deleted")


# ---------------------------------------------------------------------------
# Referrals
# ---------------------------------------------------------------------------
class ReferralStatus(models.TextChoices):
    PENDING = "PENDING"
    REGISTERED = "REGISTERED"
    FIRST_ORDER_PLACED = "FIRST_ORDER_PLACED"
    ORDER_DELIVERED = "ORDER_DELIVERED"
    REWARD_CREDITED = "REWARD_CREDITED"
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"


class ReferralRewardStatus(models.TextChoices):
    NONE = "NONE"
    HELD = "HELD"  # risk flags: waits for an admin
    CREDITING = "CREDITING"
    CREDITED = "CREDITED"
    PARTIAL = "PARTIAL"
    REJECTED = "REJECTED"


class ReferralRisk(models.TextChoices):
    SAME_SIGNUP_IP = "SAME_SIGNUP_IP"
    ADDRESS_MATCHES_REFERRER = "ADDRESS_MATCHES_REFERRER"
    ADDRESS_SHARED_WITH_OTHER_REFERRAL = "ADDRESS_SHARED_WITH_OTHER_REFERRAL"
    REFERRER_VELOCITY = "REFERRER_VELOCITY"


class Referral(BaseModel):
    referrer = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="referrals_made"
    )
    referred = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="referral"
    )
    code = models.CharField(max_length=40)
    status = models.CharField(
        max_length=20, choices=ReferralStatus.choices, default=ReferralStatus.REGISTERED
    )
    qualifying_order = models.ForeignKey(
        Order, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    attribution_expires_at = models.DateTimeField()
    referrer_coins = models.PositiveIntegerField(default=0)
    referred_coins = models.PositiveIntegerField(default=0)
    reward_status = models.CharField(
        max_length=12, choices=ReferralRewardStatus.choices, default=ReferralRewardStatus.NONE
    )
    referrer_slot = models.CharField(
        max_length=40, null=True, blank=True
    )  # monthly cap bucket used
    rewarded_at = models.DateTimeField(null=True, blank=True)
    risk_flags = models.JSONField(default=list)  # ReferralRisk values
    signup_ip = models.GenericIPAddressField(null=True, blank=True)  # never returned by the API
    decision_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    decision_note = models.CharField(max_length=300, blank=True, default="")
    decision_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "referrals"
        constraints = [
            one_of("status", ReferralStatus, "referrals_status_valid"),
            one_of("reward_status", ReferralRewardStatus, "referrals_reward_status_valid"),
            models.CheckConstraint(
                condition=~models.Q(referrer=models.F("referred")), name="referrals_not_self"
            ),
        ]
        indexes = [
            models.Index(fields=["referrer", "-created_at"], name="referrals_referrer"),
            models.Index(fields=["status", "attribution_expires_at"], name="referrals_attribution"),
            models.Index(fields=["reward_status", "updated_at"], name="referrals_reward"),
        ]


class ReferralEvent(AppendOnlyModel):
    referral = models.ForeignKey(Referral, on_delete=models.CASCADE, related_name="history")
    status = models.CharField(max_length=20, choices=ReferralStatus.choices)
    note = models.CharField(max_length=200, blank=True, default="")

    class Meta:
        db_table = "referral_history"
        ordering = ["created_at"]


class ReferralRewardCounter(BaseModel):
    """Rewards per referrer per period (e.g. "2026-11"), for the monthly cap."""

    referrer = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+"
    )
    period = models.CharField(max_length=10)
    count = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "referral_reward_counters"
        constraints = [
            models.UniqueConstraint(fields=["referrer", "period"], name="referral_counters_unique")
        ]


# ---------------------------------------------------------------------------
# Special rewards
# ---------------------------------------------------------------------------
class CampaignType(models.TextChoices):
    FESTIVAL = "FESTIVAL"
    PROMOTIONAL = "PROMOTIONAL"


class CampaignTrigger(models.TextChoices):
    CLAIM = "CLAIM"
    ORDER = "ORDER"


class CampaignStatus(models.TextChoices):
    DRAFT = "DRAFT"
    SCHEDULED = "SCHEDULED"
    ACTIVE = "ACTIVE"
    PAUSED = "PAUSED"
    EXPIRED = "EXPIRED"
    COMPLETED = "COMPLETED"


class CustomerGroup(models.TextChoices):
    ALL = "ALL"
    NEW = "NEW"
    EXISTING = "EXISTING"
    INACTIVE = "INACTIVE"


class RewardCampaign(BaseModel):
    name = models.CharField(max_length=80)
    description = models.CharField(max_length=500, blank=True, default="")
    type = models.CharField(max_length=12, choices=CampaignType.choices)
    trigger = models.CharField(
        max_length=6, choices=CampaignTrigger.choices, default=CampaignTrigger.CLAIM
    )
    reward_coins = models.PositiveIntegerField(
        validators=[MinValueValidator(1), MaxValueValidator(MAX_REWARD_COINS)]
    )
    start_at = models.DateTimeField()
    end_at = models.DateTimeField()
    # When this campaign's coins expire; null = the expiry period in the reward settings.
    coins_expire_at = models.DateTimeField(null=True, blank=True)
    timezone = models.CharField(max_length=60, default="Asia/Kolkata")
    status = models.CharField(
        max_length=10, choices=CampaignStatus.choices, default=CampaignStatus.DRAFT
    )
    # Conditions
    customer_group = models.CharField(
        max_length=10, choices=CustomerGroup.choices, default=CustomerGroup.ALL
    )
    inactive_days = models.PositiveSmallIntegerField(
        default=30, validators=[MinValueValidator(1), MaxValueValidator(3650)]
    )
    min_order_paise = models.BigIntegerField(default=0)
    first_order_only = models.BooleanField(default=False)
    restaurants = models.ManyToManyField(
        Restaurant, blank=True, related_name="+", db_table="reward_campaign_restaurants"
    )
    # Limits
    max_claims_per_customer = models.PositiveIntegerField(
        default=1, validators=[MinValueValidator(1), MaxValueValidator(1000)]
    )
    max_total_claims = models.PositiveIntegerField(null=True, blank=True)
    max_total_coins = models.PositiveBigIntegerField(null=True, blank=True)
    # Stats
    claims_count = models.PositiveIntegerField(default=0)
    coins_issued = models.PositiveBigIntegerField(default=0)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    class Meta:
        db_table = "reward_campaigns"
        constraints = [
            one_of("type", CampaignType, "reward_campaigns_type_valid"),
            one_of("trigger", CampaignTrigger, "reward_campaigns_trigger_valid"),
            one_of("status", CampaignStatus, "reward_campaigns_status_valid"),
            one_of("customer_group", CustomerGroup, "reward_campaigns_group_valid"),
            models.CheckConstraint(
                condition=models.Q(end_at__gt=models.F("start_at")), name="reward_campaigns_dates"
            ),
            models.CheckConstraint(
                condition=models.Q(coins_expire_at__isnull=True)
                | models.Q(coins_expire_at__gt=models.F("end_at")),
                name="reward_campaigns_coins_expire_after_end",
            ),
            non_negative("min_order_paise", "reward_campaigns_min_order_non_negative"),
        ]
        indexes = [
            models.Index(fields=["status", "start_at", "end_at"], name="reward_campaigns_window"),
            models.Index(fields=["status", "trigger"], name="reward_campaigns_trigger"),
            models.Index(fields=["-created_at"], name="reward_campaigns_recent"),
        ]


class RewardType(models.TextChoices):
    WELCOME = "WELCOME"
    BIRTHDAY = "BIRTHDAY"
    FESTIVAL = "FESTIVAL"
    PROMOTIONAL = "PROMOTIONAL"


class ClaimStatus(models.TextChoices):
    PENDING = "PENDING"
    ISSUED = "ISSUED"


class RewardClaim(BaseModel):
    """`created_at` is the Node `claimedAt`."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="reward_claims"
    )
    campaign = models.ForeignKey(
        RewardCampaign, on_delete=models.PROTECT, null=True, blank=True, related_name="claims"
    )
    reward_type = models.CharField(max_length=12, choices=RewardType.choices)
    coins = models.PositiveIntegerField(
        validators=[MinValueValidator(1), MaxValueValidator(MAX_REWARD_COINS)]
    )
    status = models.CharField(
        max_length=8, choices=ClaimStatus.choices, default=ClaimStatus.PENDING
    )
    order = models.ForeignKey(
        Order, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    txn = models.ForeignKey(
        CoinTransaction, on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    # e.g. "birthday:<userId>:2026", "campaign:<id>:<userId>:1": a claim can't be issued twice.
    claim_key = models.CharField(max_length=200, unique=True)
    issued_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "reward_claims"
        constraints = [
            one_of("reward_type", RewardType, "reward_claims_type_valid"),
            one_of("status", ClaimStatus, "reward_claims_status_valid"),
            # One reward per campaign per order.
            models.UniqueConstraint(
                fields=["campaign", "order"],
                condition=models.Q(campaign__isnull=False, order__isnull=False),
                name="reward_claims_campaign_order",
            ),
        ]
        indexes = [
            models.Index(fields=["user", "-created_at"], name="reward_claims_user"),
            models.Index(fields=["campaign", "user"], name="reward_claims_campaign_user"),
            models.Index(fields=["campaign", "-created_at"], name="reward_claims_campaign"),
            models.Index(fields=["status", "updated_at"], name="reward_claims_status"),
        ]


class RewardConfiguration(BaseModel):
    """
    The programme settings, one row (`key="global"`). `value` holds the nested settings in
    snake_case (earning, redemption, expiry, referral, birthday, welcome; the API shows them in
    camelCase); missing values fall back to the defaults in apps/coins/quote.py. Validated on
    write by apps/coins/config.py.
    """

    key = models.CharField(max_length=20, unique=True, default="global", editable=False)
    coins_enabled = models.BooleanField(default=True)
    value = models.JSONField(default=dict)
    timezone = models.CharField(max_length=60, default="Asia/Kolkata")
    revision = models.PositiveIntegerField(default=0)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    class Meta:
        db_table = "reward_configuration"
