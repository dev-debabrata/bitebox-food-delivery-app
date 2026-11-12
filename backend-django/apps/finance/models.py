"""
Settlements and payouts (Node: `order.settlement`, `order.payouts`, models/payout.model.js).
Each delivered order gets one settlement row splitting the money; payouts pay those rows out.
"""

from django.conf import settings
from django.db import models

from apps.orders.models import Order
from apps.restaurants.models import Restaurant
from common.models import BaseModel, non_negative, one_of


class PayoutType(models.TextChoices):
    RESTAURANT = "restaurant"
    RIDER = "rider"


class PayoutStatus(models.TextChoices):
    PENDING = "pending"
    PAID = "paid"
    CANCELLED = "cancelled"


class Payout(BaseModel):
    type = models.CharField(max_length=10, choices=PayoutType.choices)
    restaurant = models.ForeignKey(
        Restaurant, on_delete=models.PROTECT, null=True, blank=True, related_name="payouts"
    )
    payee = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="payouts"
    )
    payee_name = models.CharField(max_length=100)
    orders_count = models.PositiveIntegerField(default=0)
    amount_paise = models.BigIntegerField(default=0)
    period_from = models.DateTimeField(null=True, blank=True)
    period_to = models.DateTimeField(null=True, blank=True)
    status = models.CharField(
        max_length=10, choices=PayoutStatus.choices, default=PayoutStatus.PENDING
    )
    reference = models.CharField(max_length=120, blank=True, default="")  # bank transfer reference
    note = models.CharField(max_length=500, blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )
    paid_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    paid_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "payouts"
        constraints = [
            one_of("type", PayoutType, "payouts_type_valid"),
            one_of("status", PayoutStatus, "payouts_status_valid"),
            non_negative("amount_paise", "payouts_amount_non_negative"),
            models.CheckConstraint(
                condition=~models.Q(type="restaurant") | models.Q(restaurant__isnull=False),
                name="payouts_restaurant_has_restaurant",
            ),
        ]
        indexes = [
            models.Index(fields=["type", "status", "-created_at"], name="payouts_type_status"),
            models.Index(fields=["payee", "-created_at"], name="payouts_payee_recent"),
        ]


class OrderSettlement(BaseModel):
    """How a delivered order's money splits. Written once by the workflow at delivery."""

    order = models.OneToOneField(Order, on_delete=models.PROTECT, related_name="settlement")
    restaurant_paise = models.BigIntegerField()
    rider_paise = models.BigIntegerField()
    platform_paise = models.BigIntegerField()  # may be negative when fees don't cover rider pay
    settled_at = models.DateTimeField()
    # Claimed by a payout (null = still due).
    restaurant_payout = models.ForeignKey(
        Payout,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="restaurant_settlements",
    )
    rider_payout = models.ForeignKey(
        Payout, on_delete=models.SET_NULL, null=True, blank=True, related_name="rider_settlements"
    )

    class Meta:
        db_table = "order_settlements"
        constraints = [
            non_negative("restaurant_paise", "order_settlements_restaurant_non_negative"),
            non_negative("rider_paise", "order_settlements_rider_non_negative"),
        ]
        indexes = [
            models.Index(fields=["settled_at"], name="order_settlements_settled"),
            models.Index(fields=["restaurant_payout"], name="order_settlements_rest_payout"),
            models.Index(fields=["rider_payout"], name="order_settlements_rider_payout"),
        ]
