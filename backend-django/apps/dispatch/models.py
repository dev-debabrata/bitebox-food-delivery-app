"""
Offers of an order to riders, one at a time (replaces Node's `order.offer` and `order.declinedBy`).
Riders who declined or let an offer expire are not offered the same order again.
"""

from django.conf import settings
from django.db import models

from common.models import BaseModel, one_of


class AssignmentStatus(models.TextChoices):
    OFFERED = "offered"
    ACCEPTED = "accepted"
    DECLINED = "declined"
    EXPIRED = "expired"
    CANCELLED = "cancelled"
    COMPLETED = "completed"


LIVE_STATUSES = (AssignmentStatus.OFFERED, AssignmentStatus.ACCEPTED)


class DeliveryAssignment(BaseModel):
    order = models.ForeignKey("orders.Order", on_delete=models.CASCADE, related_name="assignments")
    rider = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="assignments"
    )
    status = models.CharField(
        max_length=10, choices=AssignmentStatus.choices, default=AssignmentStatus.OFFERED
    )
    offered_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    responded_at = models.DateTimeField(null=True, blank=True)
    # Set when an admin assigned the rider directly instead of an offer.
    assigned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    class Meta:
        db_table = "delivery_assignments"
        constraints = [
            one_of("status", AssignmentStatus, "delivery_assignments_status_valid"),
            # An order has at most one live offer or accepted rider at a time.
            models.UniqueConstraint(
                fields=["order"],
                condition=models.Q(status__in=[s.value for s in LIVE_STATUSES]),
                name="delivery_assignments_one_live_per_order",
            ),
        ]
        indexes = [
            models.Index(fields=["status", "expires_at"], name="delivery_assignments_expiry"),
            models.Index(fields=["rider", "status"], name="delivery_assignments_rider"),
            models.Index(fields=["order", "status"], name="delivery_assignments_order"),
        ]
