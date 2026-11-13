"""
The reward settings (Node: services/reward-config.service.js, models/reward-configuration.model.js
and validators/rewards.validators.js#updateConfigRules).

One row (`key="global"`); `value` holds the nested settings in snake_case, missing values read as
the defaults in quote.py. The API shows them in camelCase with `version` (the revision editors send
back) and who saved them last. Validation answers like Node: first the request rules (types), then
the model rules (ranges, choices), each as a 422 with `{field, message}` details.
"""

import logging
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db import IntegrityError, transaction

from common.api import ApiError

from .models import EARN_SOURCES, MAX_COINS_PER_OPERATION, MAX_REWARD_COINS, RewardConfiguration
from .quote import DEFAULT_REWARD_CONFIG, get_reward_config

logger = logging.getLogger("bitebox.coins")

KEY = "global"
SECTIONS = ("earning", "redemption", "expiry", "referral", "birthday", "welcome")
MAX_PAISE = 100_000_000  # ₹10 lakh
MAX_EXPIRY_DAYS = 3650
PAYMENT_METHODS = ("cod", "online")
WELCOME_TRIGGERS = ("registration", "first_order")
CHANGED = "The reward settings were changed by someone else. Reload them and try again."

R = MAX_REWARD_COINS
# Model ranges per setting (Node: the `whole(min, max)` paths of the configuration schema).
RANGES: dict[str, tuple[int, int]] = {
    "earning.order.coins_per_unit": (0, R),
    "earning.order.unit_paise": (100, MAX_PAISE),
    "earning.order.min_order_paise": (0, MAX_PAISE),
    "earning.order.max_coins_per_order": (0, R),
    "earning.review.coins": (0, R),
    "earning.review.min_comment_length": (0, 1000),
    "redemption.coin_value_coins": (1, R),
    "redemption.coin_value_paise": (1, MAX_PAISE),
    "redemption.min_coins": (1, MAX_COINS_PER_OPERATION),
    "redemption.max_coins_per_order": (1, MAX_COINS_PER_OPERATION),
    "redemption.max_percent_of_order": (1, 100),
    "redemption.min_order_paise": (0, MAX_PAISE),
    **{f"expiry.days.{s.value}": (0, MAX_EXPIRY_DAYS) for s in EARN_SOURCES},
    "expiry.restore_grace_days": (0, 365),
    "expiry.expiring_soon_days": (1, 365),
    "referral.referrer_coins": (0, R),
    "referral.referred_coins": (0, R),
    "referral.min_order_paise": (0, MAX_PAISE),
    "referral.attribution_days": (1, 365),
    "referral.max_referrals_per_customer": (1, 100_000),
    "referral.max_rewards_per_month": (1, 10_000),
    "birthday.coins": (0, R),
    "welcome.coins": (0, R),
}

# The settings' shape: every leaf with its default (timezone and the master switch included).
SHAPE: dict[str, Any] = {
    "coins_enabled": True,
    **{k: DEFAULT_REWARD_CONFIG[k] for k in SECTIONS},
    "timezone": "Asia/Kolkata",
}


def camel_path(path: str) -> str:
    """earning.order.coins_per_unit → earning.order.coinsPerUnit (source names stay as they are)."""

    def camel(part: str) -> str:
        if part.isupper():
            return part
        head, *rest = part.split("_")
        return head + "".join(p[:1].upper() + p[1:] for p in rest)

    return ".".join(camel(p) for p in path.split("."))


def _fail(details: list[dict[str, str]]) -> ApiError:
    return ApiError(422, "Validation failed", code="VALIDATION_ERROR", details=details)


def _is_int(value: Any) -> bool:
    """express-validator isInt: whole numbers, or text holding one."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    if isinstance(value, float):
        return value.is_integer()
    if isinstance(value, str):
        text = value.strip()
        return text.lstrip("+-").isdigit()
    return False


def _to_int(value: Any) -> int:
    return int(float(str(value).strip()))


def _clean(
    value: Any, shape: dict[str, Any], prefix: str, details: list[dict[str, str]]
) -> dict[str, Any]:
    """The request rules: known settings only, each of the right type (Node: settingRules)."""
    out: dict[str, Any] = {}
    if not isinstance(value, dict):
        return out
    for key, default in shape.items():
        incoming_key = key.lower() if key.isupper() else key  # the camelCase parser lowered it
        if incoming_key not in value and key not in value:
            continue
        raw = value.get(key, value.get(incoming_key))
        path = f"{prefix}.{key}" if prefix else key
        name = camel_path(path)
        if isinstance(default, dict):
            nested = _clean(raw, default, path, details)
            if nested:
                out[key] = nested
        elif isinstance(default, bool):
            if not isinstance(raw, bool):
                details.append({"field": name, "message": f"{name} must be true or false"})
            else:
                out[key] = raw
        elif isinstance(default, int):
            if not _is_int(raw) or not 0 <= _to_int(raw) <= 1_000_000_000:
                details.append({"field": name, "message": f"{name} must be a whole number"})
            else:
                out[key] = _to_int(raw)
        elif isinstance(default, list):
            if not isinstance(raw, list) or len(raw) > 10:
                details.append({"field": name, "message": "Invalid value"})
            elif not all(isinstance(item, str) for item in raw):
                index = next(i for i, item in enumerate(raw) if not isinstance(item, str))
                details.append({"field": f"{name}[{index}]", "message": "Invalid value"})
            else:
                out[key] = [item.strip() for item in raw]
        elif not isinstance(raw, str) or len(raw.strip()) > 60:
            details.append({"field": name, "message": "Invalid value"})
        else:
            out[key] = raw.strip()
    return out


def _merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in patch.items():
        out[key] = (
            _merge(out[key], value)
            if isinstance(value, dict) and isinstance(out.get(key), dict)
            else value
        )
    return out


def _leaf(config: dict[str, Any], path: str) -> Any:
    value: Any = config
    for part in path.split("."):
        value = value[part]
    return value


def _check(config: dict[str, Any]) -> None:
    """The model rules (Node: the schema's min/max/enum, the time zone and checkRanges)."""
    details: list[dict[str, str]] = []
    for path, (lo, hi) in RANGES.items():
        value = _leaf(config, path)
        name = camel_path(path)
        if value < lo:
            details.append(
                {
                    "field": name,
                    "message": f"Path `{name}` ({value}) is less than minimum allowed value "
                    f"({lo}).",
                }
            )
        elif value > hi:
            details.append(
                {
                    "field": name,
                    "message": f"Path `{name}` ({value}) is more than maximum allowed value "
                    f"({hi}).",
                }
            )
    for i, method in enumerate(config["redemption"]["payment_methods"]):
        if method not in PAYMENT_METHODS:
            name = f"redemption.paymentMethods.{i}"
            details.append(
                {
                    "field": name,
                    "message": f"`{method}` is not a valid enum value for path `{name}`.",
                }
            )
    trigger = config["welcome"]["trigger"]
    if trigger not in WELCOME_TRIGGERS:
        details.append(
            {
                "field": "welcome.trigger",
                "message": f"`{trigger}` is not a valid enum value for path `welcome.trigger`.",
            }
        )
    try:
        ZoneInfo(config["timezone"])
    except (ZoneInfoNotFoundError, ValueError):
        details.append({"field": "timezone", "message": "Unknown time zone"})
    r = config["redemption"]
    if r["min_coins"] > r["max_coins_per_order"]:
        details.append(
            {
                "field": "redemption.minCoins",
                "message": "Minimum redemption cannot be more than the maximum per order",
            }
        )
    if details:
        raise _fail(details)


def present(config: dict[str, Any], row: RewardConfiguration | None) -> dict[str, Any]:
    """The settings as the admin API shows them (Node: reward-config.service.js#present)."""
    data: dict[str, Any] = {
        "coins_enabled": config["coins_enabled"],
        **{k: config[k] for k in SECTIONS},
        "timezone": config["timezone"],
        "updated_by": str(row.updated_by_id) if row and row.updated_by_id else None,
        "version": row.revision if row else 0,
    }
    if row is not None:
        data["updated_at"] = row.updated_at
    return data


def current() -> dict[str, Any]:
    return present(get_reward_config(), RewardConfiguration.objects.filter(key=KEY).first())


def parse_update(data: Any) -> tuple[dict[str, Any], int]:
    """The PUT body → (the known settings, the version the editor loaded). 422 on bad types."""
    details: list[dict[str, str]] = []
    body = data if isinstance(data, dict) else {}
    version = body.get("version")
    if not _is_int(version) or _to_int(version) < 0:
        details.append({"field": "version", "message": "Send the version you loaded"})
    patch = _clean(body, SHAPE, "", details)
    if details:
        raise _fail(details)
    return patch, _to_int(version)


def update(user: Any, patch: dict[str, Any], expected_version: int | None = None) -> dict[str, Any]:
    """
    Saves a partial change (nested settings merged, lists replaced). `expected_version` refuses a
    save over someone else's newer change (409 CONFIG_CHANGED). Unknown fields are ignored.
    """
    details: list[dict[str, str]] = []
    patch = _clean(patch, SHAPE, "", details)
    if details:
        raise _fail(details)
    try:
        with transaction.atomic():
            row = RewardConfiguration.objects.select_for_update().filter(key=KEY).first()
            if expected_version is not None and expected_version != (row.revision if row else 0):
                raise ApiError.conflict(CHANGED, "CONFIG_CHANGED")
            merged = _merge(get_reward_config(), patch)
            _check(merged)
            if row is None:
                row = RewardConfiguration(key=KEY)
            row.coins_enabled = merged["coins_enabled"]
            row.timezone = merged["timezone"]
            row.value = {k: merged[k] for k in SECTIONS}
            row.revision += 1
            row.updated_by = user if getattr(user, "pk", None) else None
            row.save()
    except IntegrityError:  # created by someone else at the same moment
        raise ApiError.conflict(CHANGED, "CONFIG_CHANGED") from None
    logger.info(
        "Reward configuration updated",
        extra={"by": str(getattr(user, "pk", "") or ""), "fields": sorted(patch)},
    )
    return current()


# ---------------------------------------------------------------------------
# Pure helpers over a configuration value
# ---------------------------------------------------------------------------
def expiry_for(source: str, config: dict[str, Any], now: datetime) -> datetime | None:
    """When coins earned now from `source` expire (None = never)."""
    if not config["expiry"]["enabled"]:
        return None
    days = (config["expiry"].get("days") or {}).get(source, 0)
    return now + timedelta(days=days) if days > 0 else None


def restored_expiry(
    original: datetime | None, config: dict[str, Any], now: datetime
) -> datetime | None:
    """The earliest expiry for coins given back to a customer (cancelled order)."""
    if original is None:
        return None
    floor = now + timedelta(days=config["expiry"]["restore_grace_days"])
    return original if original > floor else floor
