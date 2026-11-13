"""
The path a rider took while carrying an order (master prompt §10, data model "tracking points").
Sampled at most every TRACKING_SAMPLE_SECONDS per rider and deleted after
TRACKING_RETENTION_DAYS by `tracking.purge` (Celery Beat). Positions are kept only while the
rider has an order in a tracked status: never while they are just online.
"""

from django.conf import settings
from django.contrib.postgres.indexes import BrinIndex
from django.db import models

from apps.orders.models import Order
from common.geo import PointField
from common.models import AppendOnlyModel


class TrackingPoint(AppendOnlyModel):
    rider = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="tracking_points"
    )
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="tracking_points")
    location = PointField()
    accuracy_m = models.FloatField(null=True, blank=True)
    recorded_at = models.DateTimeField()

    class Meta:
        db_table = "tracking_points"
        indexes = [
            models.Index(fields=["order", "recorded_at"], name="tracking_points_order_time"),
            models.Index(fields=["rider", "-recorded_at"], name="tracking_points_rider_recent"),
            # Purging by age scans this cheaply (rows arrive in time order).
            BrinIndex(fields=["recorded_at"], name="tracking_points_time_brin"),
        ]
