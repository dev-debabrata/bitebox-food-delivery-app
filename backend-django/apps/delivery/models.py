"""
Delivery partners (Node: models/delivery-partner.model.js).
KYC documents and bank details come in a later phase.
"""

from django.conf import settings
from django.db import models

from common.geo import PointField
from common.models import BaseModel, RatingSummary, one_of


class VehicleType(models.TextChoices):
    BICYCLE = "bicycle"
    SCOOTER = "scooter"
    MOTORBIKE = "motorbike"
    CAR = "car"


class DeliveryPartner(BaseModel, RatingSummary):
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="delivery_partner"
    )
    is_online = models.BooleanField(default=False)
    location = PointField(null=True, blank=True)  # last reported GPS fix
    location_updated_at = models.DateTimeField(null=True, blank=True)
    location_accuracy_m = models.FloatField(null=True, blank=True)
    # Compare-and-set locks: dispatch only offers to a rider whose two locks are both empty.
    current_offer = models.ForeignKey(
        "orders.Order", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    active_order = models.ForeignKey(
        "orders.Order", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    last_assigned_at = models.DateTimeField(null=True, blank=True)
    completed_deliveries = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "delivery_partners"
        indexes = [
            models.Index(
                fields=["is_online", "active_order", "current_offer"], name="delivery_partners_free"
            )
        ]


class RiderVehicle(BaseModel):
    partner = models.OneToOneField(
        DeliveryPartner, on_delete=models.CASCADE, related_name="vehicle"
    )
    vehicle_type = models.CharField(max_length=10, choices=VehicleType.choices)
    vehicle_number = models.CharField(max_length=20)

    class Meta:
        db_table = "rider_vehicles"
        constraints = [one_of("vehicle_type", VehicleType, "rider_vehicles_type_valid")]
