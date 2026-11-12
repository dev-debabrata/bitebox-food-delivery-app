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
