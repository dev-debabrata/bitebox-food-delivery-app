"""
Coins, referrals and rewards request validation, answering like the Node API's
validators/rewards.validators.js: the same fields, messages and 422 `details` paths.
"""

import re
from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers
from rest_framework.fields import empty

from common.fields import QueryBoolean, UUIDRef
from common.validation import PageQuery

from .models import (
    MAX_COINS_PER_OPERATION,
    MAX_REWARD_COINS,
    CampaignStatus,
    CampaignTrigger,
    CampaignType,
    CoinSource,
    CustomerGroup,
    ReferralRewardStatus,
    ReferralStatus,
    RewardType,
    TxnType,
)

INVALID = "Invalid value"


def choice(choices: list[str], message: str = INVALID) -> serializers.ChoiceField:
    keys = ("invalid_choice", "null", "blank")
    return serializers.ChoiceField(
        choices=choices, required=False, error_messages=dict.fromkeys(keys, message)
    )


def whole(
    min_value: int, max_value: int, message: str = INVALID, **kwargs: Any
) -> serializers.IntegerField:
    keys = ("required", "null", "invalid", "min_value", "max_value", "max_string_length")
    kwargs.setdefault("required", False)
    return serializers.IntegerField(
        min_value=min_value,
        max_value=max_value,
        error_messages=dict.fromkeys(keys, message),
        **kwargs,
    )


class StrictBool(serializers.BooleanField):
    """isBoolean({ strict: true }): only true or false."""

    def to_internal_value(self, data: Any) -> bool:
        if not isinstance(data, bool):
            self.fail("invalid")
        return data


class Text(serializers.CharField):
    """A trimmed string that must really be a string (DRF would turn numbers into text)."""

    def to_internal_value(self, data: Any) -> str:
        if not isinstance(data, str):
            self.fail("invalid")
        return super().to_internal_value(data)


# ---------------------------------------------------------------------------
# Customer
# ---------------------------------------------------------------------------
class CoinTransactionQuery(PageQuery):
    type = choice(TxnType.values, "Unknown type")
    source = choice(CoinSource.values, "Unknown source")  # type: ignore[assignment]


# What customers see: every stage except the never-stored PENDING, and REJECTED as NOT_ELIGIBLE.
CUSTOMER_STATUSES = [s for s in ReferralStatus.values if s not in ("PENDING", "REJECTED")] + [
    "NOT_ELIGIBLE"
]


class ReferralHistoryQuery(PageQuery):
    status = choice(CUSTOMER_STATUSES, "Unknown status")


class RewardHistoryQuery(PageQuery):
    reward_type = choice(RewardType.values, "Unknown reward type")


class ReferralCodeInput(serializers.Serializer):
    code = Text(
        min_length=4,
        max_length=40,
        error_messages=dict.fromkeys(
            ("required", "null", "blank", "invalid", "min_length", "max_length"),
            "Enter a referral code",
        ),
    )

    def validate_code(self, value: str) -> str:
        return value.upper()


class BirthdayInput(serializers.Serializer):
    birth_date = Text(
        error_messages=dict.fromkeys(
            ("required", "null", "blank", "invalid"), "Enter the date as YYYY-MM-DD"
        ),
        trim_whitespace=False,
    )

    def validate_birth_date(self, value: str) -> str:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise serializers.ValidationError("Enter the date as YYYY-MM-DD")
        return value


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
@extend_schema_field({"type": "integer", "nullable": True})
class NullableWhole(serializers.Field):
    """Empty (null) or a whole number in a range (Node: nullableInt)."""

    def __init__(self, min_value: int, max_value: int, **kwargs: Any) -> None:
        kwargs.setdefault("required", False)
        kwargs.setdefault("allow_null", True)
        super().__init__(**kwargs)
        self.range = (min_value, max_value)

    def run_validation(self, data: Any = empty) -> Any:
        if data is None:
            return None
        return super().run_validation(data)

    def to_internal_value(self, data: Any) -> int:
        lo, hi = self.range
        if isinstance(data, bool) or not isinstance(data, int) or not lo <= data <= hi:
            name = str(self.field_name)
            path = f"{self.parent.field_name}.{name}" if self.parent else name
            camel = re.sub(r"_(\w)", lambda m: m.group(1).upper(), path)
            raise serializers.ValidationError(f"{camel} must be empty or a whole number from {lo}")
        return data

    def to_representation(self, value: Any) -> Any:
        return value


class ConditionsInput(serializers.Serializer):
    customer_group = choice(CustomerGroup.values)
    inactive_days = whole(1, 3650)
    min_order_paise = whole(0, 100_000_000)
    first_order_only = StrictBool(required=False, error_messages={"invalid": INVALID})
    restaurants = serializers.ListField(
        child=UUIDRef(message="Invalid restaurant"),
        required=False,
        max_length=100,
        error_messages=dict.fromkeys(("not_a_list", "max_length", "null"), INVALID),
    )


class LimitsInput(serializers.Serializer):
    max_claims_per_customer = whole(1, 1000)
    max_total_claims = NullableWhole(1, 10_000_000)
    max_total_coins = NullableWhole(1, MAX_COINS_PER_OPERATION * 100)


class CoinsExpireAt(serializers.DateTimeField):
    """A date and time, or null (the expiry period in the reward settings)."""

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("required", False)
        kwargs.setdefault("allow_null", True)
        super().__init__(**kwargs)
        self.error_messages["invalid"] = "Coin expiry: a date and time, or empty"


def _date(message: str, required: bool) -> serializers.DateTimeField:
    return serializers.DateTimeField(
        required=required,
        error_messages=dict.fromkeys(("required", "null", "invalid", "date"), message),
    )


class CampaignInput(serializers.Serializer):
    """Create (everything needed) or, with `partial=True`, edit."""

    name = Text(
        min_length=3,
        max_length=80,
        error_messages=dict.fromkeys(
            ("required", "null", "blank", "invalid", "min_length", "max_length"),
            "Name: 3 to 80 characters",
        ),
    )
    description = Text(required=False, allow_blank=True, max_length=500)
    type = serializers.ChoiceField(
        choices=CampaignType.values,
        error_messages=dict.fromkeys(
            ("required", "null", "blank", "invalid_choice"), "Choose festival or promotional"
        ),
    )
    trigger = choice(CampaignTrigger.values)
    reward_coins = whole(1, MAX_REWARD_COINS, "Reward: a whole number of coins", required=True)
    start_at = _date("Start: a date and time", True)
    end_at = _date("End: a date and time", True)
    coins_expire_at = CoinsExpireAt()
    timezone = Text(required=False, max_length=60)
    conditions = ConditionsInput(required=False)
    limits = LimitsInput(required=False)


class CampaignStatusInput(serializers.Serializer):
    action = serializers.ChoiceField(
        choices=["activate", "pause", "end"],
        error_messages=dict.fromkeys(
            ("required", "null", "blank", "invalid_choice"), "Choose activate, pause or end"
        ),
    )


class CampaignListQuery(PageQuery):
    status = choice(CampaignStatus.values)
    type = choice(CampaignType.values)


class ClaimListQuery(PageQuery):
    reward_type = choice(RewardType.values)
    campaign = UUIDRef(message=INVALID, required=False)


class AdminTransactionQuery(CoinTransactionQuery):
    user_id = UUIDRef(message=INVALID, required=False)
    from_ = serializers.DateTimeField(required=False, error_messages={"invalid": INVALID})
    to = serializers.DateTimeField(required=False, error_messages={"invalid": INVALID})

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        # `from` is a Python keyword: declare it under another name, read it as `from`.
        self.fields["from"] = self.fields.pop("from_")


IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9_-]{8,100}$")


class ReverseInput(serializers.Serializer):
    coins = whole(1, MAX_COINS_PER_OPERATION)
    reason = Text(
        min_length=3,
        max_length=300,
        error_messages=dict.fromkeys(
            ("required", "null", "blank", "invalid", "min_length", "max_length"),
            "Give a reason (3-300 characters)",
        ),
    )


class AdminReferralQuery(PageQuery):
    status = choice(ReferralStatus.values)
    reward_status = choice(ReferralRewardStatus.values)
    flagged = QueryBoolean()


class DecisionInput(serializers.Serializer):
    """`note`: optional to approve, 3+ characters to reject (Node: referralDecisionRules)."""

    note = Text(
        required=False,
        allow_blank=True,
        max_length=300,
        error_messages=dict.fromkeys(
            ("required", "null", "invalid", "max_length", "min_length"),
            "Add a note (up to 300 characters)",
        ),
    )


class RejectInput(DecisionInput):
    note = Text(
        min_length=3,
        max_length=300,
        error_messages=dict.fromkeys(
            ("required", "null", "blank", "invalid", "max_length", "min_length"),
            "Add a note (up to 300 characters)",
        ),
    )


class DaysQuery(serializers.Serializer):
    days = whole(1, 365)
