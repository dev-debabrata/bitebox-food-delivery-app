"""Coupons: checkout eligibility, the public list, admin CRUD (Node: services/coupon.service.js)."""

import uuid
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import F, Q
from django.utils import timezone

from apps.cart.pricing import js_round
from common.api import ApiError
from common.pagination import Page, paginate

from .models import Coupon, CouponRedemption

FIELDS = (
    "code",
    "description",
    "discount_type",
    "discount_value",
    "max_discount_paise",
    "min_order_paise",
    "valid_from",
    "valid_until",
    "is_active",
    "usage_limit",
    "per_user_limit",
    "restaurant",
)


def _invalid(message: str, code: str = "COUPON_INVALID") -> ApiError:
    return ApiError(422, message, code=code)


def assert_eligible(code: str, *, user_id: Any, restaurant_id: Any, subtotal_paise: int) -> Coupon:
    coupon = Coupon.objects.filter(code=str(code).strip().upper()).first()
    if coupon is None or not coupon.is_active:
        raise _invalid("This coupon code is not valid")
    now = timezone.now()
    if now < coupon.valid_from:
        raise _invalid("This coupon is not active yet")
    if now > coupon.valid_until:
        raise _invalid("This coupon has expired")
    if coupon.restaurant_id and str(coupon.restaurant_id) != str(restaurant_id):
        raise _invalid("This coupon is not valid at this restaurant")
    if subtotal_paise < coupon.min_order_paise:
        more = js_round((coupon.min_order_paise - subtotal_paise) / 100)
        raise _invalid(f"Add items worth ₹{more} more to use this coupon", "COUPON_MIN_ORDER")
    if coupon.usage_limit is not None and coupon.used_count >= coupon.usage_limit:
        raise _invalid("This coupon has been fully redeemed", "COUPON_EXHAUSTED")
    if (
        CouponRedemption.objects.filter(coupon=coupon, user_id=user_id).count()
        >= coupon.per_user_limit
    ):
        raise _invalid("You have already used this coupon", "COUPON_USED")
    return coupon


def coupon_json(c: Coupon, *, restaurant: Any = "id") -> dict[str, Any]:
    if restaurant == "id":
        restaurant_value: Any = str(c.restaurant_id) if c.restaurant_id else None
    else:
        r = c.restaurant
        restaurant_value = {"id": str(r.pk), "name": r.name, "slug": r.slug} if r else None
    data = {
        "id": str(c.pk),
        "code": c.code,
        "discount_type": c.discount_type,
        "discount_value": c.discount_value,
        "max_discount_paise": c.max_discount_paise,
        "min_order_paise": c.min_order_paise,
        "valid_from": c.valid_from,
        "valid_until": c.valid_until,
        "is_active": c.is_active,
        "usage_limit": c.usage_limit,
        "used_count": c.used_count,
        "per_user_limit": c.per_user_limit,
        "restaurant": restaurant_value,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
    }
    if c.description:
        data["description"] = c.description
    return data


def list_available(restaurant_id: Any = None) -> list[dict[str, Any]]:
    now = timezone.now()
    scope = Q(restaurant__isnull=True) | (
        Q(restaurant_id=restaurant_id) if restaurant_id else Q(pk__in=[])
    )
    coupons = (
        Coupon.objects.filter(is_active=True, valid_from__lte=now, valid_until__gte=now)
        .filter(scope)
        .filter(Q(usage_limit__isnull=True) | Q(used_count__lt=F("usage_limit")))
        .order_by("valid_until")[:20]
    )
    return [
        {
            "code": c.code,
            "description": c.description or None,
            "discount_type": c.discount_type,
            "discount_value": c.discount_value,
            "max_discount_paise": c.max_discount_paise,
            "min_order_paise": c.min_order_paise,
            "valid_until": c.valid_until,
        }
        for c in coupons
    ]


def admin_list(query: dict[str, Any], page: Page) -> dict[str, Any]:
    qs = Coupon.objects.select_related("restaurant").order_by("-created_at")
    if search := (query.get("search") or "").strip():
        qs = qs.filter(code__icontains=search)
    if query.get("active") is not None:
        qs = qs.filter(is_active=query["active"])
    items, meta = paginate(qs, page)
    return {"items": [coupon_json(c, restaurant="populated") for c in items], "pagination": meta}


def _check(coupon: Coupon) -> None:
    """The same cross-field rules as the Node model's pre-validate hook (422, not a DB error)."""
    details = []
    if coupon.discount_type == "percent" and coupon.discount_value > 100:
        details.append(
            {"field": "discountValue", "message": "A percentage discount cannot exceed 100"}
        )
    if coupon.valid_from and coupon.valid_until and coupon.valid_until <= coupon.valid_from:
        details.append({"field": "validUntil", "message": "End date must be after the start date"})
    if details:
        raise ApiError(422, "Validation failed", code="VALIDATION_ERROR", details=details)


def _save(coupon: Coupon) -> Coupon:
    _check(coupon)
    if Coupon.objects.filter(code=coupon.code).exclude(pk=coupon.pk).exists():
        raise ApiError.conflict("A record with this code already exists")
    try:
        with transaction.atomic():
            coupon.save()
    except IntegrityError:
        raise ApiError.conflict("A record with this code already exists") from None
    return coupon


def _apply(coupon: Coupon, data: dict[str, Any]) -> None:
    for field in FIELDS:
        if field not in data:
            continue
        if field == "restaurant":
            coupon.restaurant_id = data["restaurant"]
        elif field == "description":
            coupon.description = data["description"] or ""
        else:
            setattr(coupon, field, data[field])


def create(data: dict[str, Any]) -> Coupon:
    coupon = Coupon()
    _apply(coupon, data)
    return _save(coupon)


def update(coupon_id: uuid.UUID, data: dict[str, Any]) -> Coupon:
    coupon = Coupon.objects.filter(pk=coupon_id).first()
    if coupon is None:
        raise ApiError.not_found("Coupon not found")
    _apply(coupon, data)
    return _save(coupon)


def remove(coupon_id: uuid.UUID) -> None:
    if CouponRedemption.objects.filter(coupon_id=coupon_id).exists():
        raise ApiError.conflict("This coupon has been used. Deactivate it instead.")
    deleted, _ = Coupon.objects.filter(pk=coupon_id).delete()
    if not deleted:
        raise ApiError.not_found("Coupon not found")
