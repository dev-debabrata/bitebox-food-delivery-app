"""
Payments (Node: the Payment model in models/order.model.js). Only payments.service changes payment
state. Webhook events are stored once each, which makes replays harmless; refunds are rows of their
own so an order can be refunded in parts. `refunded_paise` counts refunds that are done or
under way, so the CHECK below stops two refunds from returning more than was paid.
"""

from django.conf import settings
from django.db import models

from apps.orders.models import Order, PaymentMethod, PaymentStatus
from common.models import AppendOnlyModel, BaseModel, non_negative, one_of


class Provider(models.TextChoices):
    CASH_ON_DELIVERY = "cash_on_delivery"
    RAZORPAY = "razorpay"
    MOCK = "mock"  # simulated payments, refused in production


class Payment(BaseModel):
    order = models.OneToOneField(Order, on_delete=models.PROTECT, related_name="payment")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="payments"
    )
    method = models.CharField(max_length=8, choices=PaymentMethod.choices)
    provider = models.CharField(max_length=20, choices=Provider.choices)
    amount_paise = models.BigIntegerField()
    refunded_paise = models.BigIntegerField(default=0)
    currency = models.CharField(max_length=3, default="INR")
    status = models.CharField(
        max_length=20, choices=PaymentStatus.choices, default=PaymentStatus.PENDING
    )
    provider_order_id = models.CharField(max_length=100, null=True, blank=True)
    provider_payment_id = models.CharField(max_length=100, null=True, blank=True)
    failure_reason = models.CharField(max_length=300, blank=True, default="")
    paid_at = models.DateTimeField(null=True, blank=True)
    refunded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "payments"
        constraints = [
            one_of("method", PaymentMethod, "payments_method_valid"),
            one_of("provider", Provider, "payments_provider_valid"),
            one_of("status", PaymentStatus, "payments_status_valid"),
            non_negative("amount_paise", "payments_amount_non_negative"),
            non_negative("refunded_paise", "payments_refunded_non_negative"),
            models.CheckConstraint(
                condition=models.Q(refunded_paise__lte=models.F("amount_paise")),
                name="payments_refund_within_amount",
            ),
            # A gateway order or payment belongs to exactly one of our payments (no double capture).
            models.UniqueConstraint(
                fields=["provider", "provider_order_id"],
                condition=models.Q(provider_order_id__isnull=False),
                name="payments_provider_order_unique",
            ),
            models.UniqueConstraint(
                fields=["provider", "provider_payment_id"],
                condition=models.Q(provider_payment_id__isnull=False),
                name="payments_provider_payment_unique",
            ),
        ]
        indexes = [
            models.Index(fields=["user", "-created_at"], name="payments_user_recent"),
            models.Index(fields=["status", "-created_at"], name="payments_status_recent"),
        ]


class WebhookEvent(AppendOnlyModel):
    """Each gateway event id is processed once (replaces Node's `payment.processedEvents`)."""

    provider = models.CharField(max_length=20, choices=Provider.choices)
    event_id = models.CharField(max_length=120)
    event_type = models.CharField(max_length=80, blank=True, default="")
    payment = models.ForeignKey(
        Payment, on_delete=models.SET_NULL, null=True, blank=True, related_name="events"
    )
    payload = models.JSONField(null=True, blank=True)
    processed_at = models.DateTimeField(null=True, blank=True)
    error = models.CharField(max_length=500, blank=True, default="")

    class Meta:
        db_table = "payment_webhook_events"
        constraints = [
            models.UniqueConstraint(
                fields=["provider", "event_id"], name="payment_webhook_events_once"
            )
        ]


class RefundStatus(models.TextChoices):
    PENDING = "pending"
    PROCESSING = "processing"
    PROCESSED = "processed"
    FAILED = "failed"
    MANUAL_PENDING = "manual_pending"  # COD: paid back outside the gateway by finance
    MANUAL_DONE = "manual_done"


class Refund(BaseModel):
    payment = models.ForeignKey(Payment, on_delete=models.PROTECT, related_name="refunds")
    amount_paise = models.BigIntegerField()
    reason = models.CharField(max_length=300, blank=True, default="")
    status = models.CharField(
        max_length=16, choices=RefundStatus.choices, default=RefundStatus.PENDING
    )
    provider_refund_id = models.CharField(max_length=100, null=True, blank=True)
    idempotency_key = models.CharField(max_length=120, unique=True)
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    failure_reason = models.CharField(max_length=300, blank=True, default="")
    processed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "refunds"
        constraints = [
            one_of("status", RefundStatus, "refunds_status_valid"),
            models.CheckConstraint(
                condition=models.Q(amount_paise__gt=0), name="refunds_amount_positive"
            ),
            models.UniqueConstraint(
                fields=["provider_refund_id"],
                condition=models.Q(provider_refund_id__isnull=False),
                name="refunds_provider_refund_unique",
            ),
        ]
