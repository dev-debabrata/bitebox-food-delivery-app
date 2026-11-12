"""Coupons and their use (Node: models/coupon.model.js)."""

from django.conf import settings
from django.core.validators import RegexValidator
from django.db import models

from apps.restaurants.models import Restaurant
from common.models import BaseModel, non_negative, one_of


class DiscountType(models.TextChoices):
    PERCENT = "percent"
    FLAT = "flat"


class Coupon(BaseModel):
    code = models.CharField(
        max_length=30, unique=True, validators=[RegexValidator(r"^[A-Z0-9_-]{3,30}$")]
    )
    description = models.CharField(max_length=200, blank=True, default="")
    discount_type = models.CharField(max_length=8, choices=DiscountType.choices)
    discount_value = models.PositiveIntegerField()  # percent (1–100) or paise
    max_discount_paise = models.BigIntegerField(null=True, blank=True)
    min_order_paise = models.BigIntegerField(default=0)
    valid_from = models.DateTimeField()
    valid_until = models.DateTimeField()
    is_active = models.BooleanField(default=True)
    usage_limit = models.PositiveIntegerField(null=True, blank=True)
    # Reserved atomically when an order is placed (select_for_update / conditional update).
    used_count = models.PositiveIntegerField(default=0)
    per_user_limit = models.PositiveIntegerField(default=1)
    restaurant = models.ForeignKey(
        Restaurant, on_delete=models.CASCADE, null=True, blank=True, related_name="coupons"
    )

    class Meta:
        db_table = "coupons"
        constraints = [
            one_of("discount_type", DiscountType, "coupons_discount_type_valid"),
            models.CheckConstraint(
                condition=models.Q(discount_value__gte=1), name="coupons_discount_value_positive"
            ),
            models.CheckConstraint(
                condition=~models.Q(discount_type="percent") | models.Q(discount_value__lte=100),
                name="coupons_percent_at_most_100",
            ),
            non_negative("min_order_paise", "coupons_min_order_non_negative"),
            models.CheckConstraint(
                condition=models.Q(max_discount_paise__isnull=True)
                | models.Q(max_discount_paise__gte=0),
                name="coupons_max_discount_non_negative",
            ),
            models.CheckConstraint(
                condition=models.Q(valid_until__gt=models.F("valid_from")),
                name="coupons_valid_range",
            ),
            models.CheckConstraint(
                condition=models.Q(usage_limit__isnull=True)
                | models.Q(used_count__lte=models.F("usage_limit")),
                name="coupons_used_within_limit",
            ),
            models.CheckConstraint(
                condition=models.Q(per_user_limit__gte=1), name="coupons_per_user_limit_positive"
            ),
        ]
        indexes = [models.Index(fields=["is_active", "valid_until"], name="coupons_active_until")]

    def __str__(self) -> str:
        return self.code


class CouponRedemption(BaseModel):
    coupon = models.ForeignKey(Coupon, on_delete=models.PROTECT, related_name="redemptions")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    order = models.OneToOneField(
        "orders.Order", on_delete=models.CASCADE, related_name="coupon_redemption"
    )
    discount_paise = models.BigIntegerField()

    class Meta:
        db_table = "coupon_redemptions"
        constraints = [non_negative("discount_paise", "coupon_redemptions_discount_non_negative")]
        indexes = [models.Index(fields=["coupon", "user"], name="coupon_redemptions_per_user")]
