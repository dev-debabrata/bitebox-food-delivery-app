"""
In-app notifications and Web Push subscriptions
(Node: models/notification.model.js, models/push-subscription.model.js).
"""

from django.conf import settings
from django.db import models

from common.models import AppendOnlyModel, BaseModel

NOTIFICATION_RETENTION_DAYS = 90  # purged daily (Node: TTL index)


class Notification(AppendOnlyModel):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications"
    )
    type = models.CharField(max_length=40)  # e.g. order.delivered, payment.failed, promo.offer
    title = models.CharField(max_length=120)
    body = models.CharField(max_length=300, blank=True, default="")
    link = models.CharField(max_length=200, blank=True, default="")
    order = models.ForeignKey(
        "orders.Order", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "notifications"
        indexes = [
            models.Index(fields=["user", "-created_at"], name="notifications_user_recent"),
            models.Index(
                fields=["user"],
                condition=models.Q(read_at__isnull=True),
                name="notifications_user_unread",
            ),
            models.Index(fields=["created_at"], name="notifications_purge"),
        ]


class PushSubscription(BaseModel):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="push_subscriptions"
    )
    endpoint = models.URLField(max_length=1000, unique=True)
    p256dh = models.CharField(max_length=200)
    auth = models.CharField(max_length=100)
    expiration_time = models.DateTimeField(null=True, blank=True)
    device = models.CharField(max_length=80, blank=True, default="")
    last_success_at = models.DateTimeField(null=True, blank=True)
    failures = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "push_subscriptions"
        indexes = [models.Index(fields=["user", "-updated_at"], name="push_subscriptions_user")]


class Channel(models.TextChoices):
    """External channels beside the in-app inbox (which every notification uses)."""

    PUSH = "push"  # Web Push to subscribed browsers
    FCM = "fcm"  # Firebase Cloud Messaging, for future native apps
    EMAIL = "email"
    SMS = "sms"


class DeliveryStatus(models.TextChoices):
    QUEUED = "queued"
    SENT = "sent"
    FAILED = "failed"  # will be retried at next_attempt_at
    DEAD = "dead"  # gave up (dead letter): admins can retry it
    SKIPPED = "skipped"  # nothing to send to any more (e.g. every browser unsubscribed)


class NotificationDelivery(BaseModel):
    """One notification on one external channel: its status, tries and last error."""

    notification = models.ForeignKey(
        Notification, on_delete=models.CASCADE, related_name="deliveries"
    )
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    channel = models.CharField(max_length=8, choices=Channel.choices)
    status = models.CharField(
        max_length=8, choices=DeliveryStatus.choices, default=DeliveryStatus.QUEUED
    )
    attempts = models.PositiveSmallIntegerField(default=0)
    last_error = models.CharField(max_length=500, blank=True, default="")
    next_attempt_at = models.DateTimeField(null=True, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "notification_deliveries"
        constraints = [
            models.UniqueConstraint(
                fields=["notification", "channel"], name="notification_deliveries_once"
            )
        ]
        indexes = [
            models.Index(fields=["status", "next_attempt_at"], name="notif_deliveries_due"),
            models.Index(fields=["status", "-created_at"], name="notif_deliveries_recent"),
        ]


class ChannelPreference(BaseModel):
    """
    Email and SMS switches per category (Web Push keeps its switches on the user, like Node's
    pushPreferences). Defaults: email for orders and account, SMS opt-in, promotions opt-in.
    """

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="channel_preferences"
    )
    email_orders = models.BooleanField(default=True)
    email_account = models.BooleanField(default=True)
    email_promotions = models.BooleanField(default=False)
    sms_orders = models.BooleanField(default=False)
    sms_account = models.BooleanField(default=False)
    sms_promotions = models.BooleanField(default=False)

    class Meta:
        db_table = "notification_preferences"


class DevicePlatform(models.TextChoices):
    ANDROID = "android"
    IOS = "ios"


class DeviceToken(BaseModel):
    """An FCM registration token of a native app install (none until the apps exist)."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="device_tokens"
    )
    token = models.CharField(max_length=500, unique=True)
    platform = models.CharField(max_length=8, choices=DevicePlatform.choices)
    last_success_at = models.DateTimeField(null=True, blank=True)
    failures = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "device_tokens"
        indexes = [models.Index(fields=["user", "-updated_at"], name="device_tokens_user")]
