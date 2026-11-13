"""
Delivery partners (Node: models/delivery-partner.model.js). Their documents and bank account are
in apps/kyc; the verification decision is here.
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


class VerificationStatus(models.TextChoices):
    PENDING = "pending"  # documents uploaded or on the way, waiting for BiteBox
    APPROVED = "approved"
    REJECTED = "rejected"
    RESUBMISSION_REQUESTED = "resubmission_requested"  # "documents needed"


# Which verification changes an admin may make.
VERIFICATION_TRANSITIONS: dict[str, frozenset[str]] = {
    VerificationStatus.PENDING: frozenset(
        {
            VerificationStatus.APPROVED,
            VerificationStatus.REJECTED,
            VerificationStatus.RESUBMISSION_REQUESTED,
        }
    ),
    VerificationStatus.RESUBMISSION_REQUESTED: frozenset(
        {VerificationStatus.APPROVED, VerificationStatus.REJECTED}
    ),
    VerificationStatus.REJECTED: frozenset({VerificationStatus.APPROVED}),
    # e.g. a licence expired: ask for it again (the rider cannot go online meanwhile).
    VerificationStatus.APPROVED: frozenset({VerificationStatus.RESUBMISSION_REQUESTED}),
}


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
    # Home address {line1, area, city, state, postal_code}, for verification.
    address = models.JSONField(null=True, blank=True)
    # Riders go online only once approved (RIDER_KYC_REQUIRED).
    verification_status = models.CharField(
        max_length=24, choices=VerificationStatus.choices, default=VerificationStatus.PENDING
    )
    verification_reason = models.CharField(max_length=500, blank=True, default="")
    verified_at = models.DateTimeField(null=True, blank=True)
    verified_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    class Meta:
        db_table = "delivery_partners"
        constraints = [
            one_of(
                "verification_status", VerificationStatus, "delivery_partners_verification_valid"
            )
        ]
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
