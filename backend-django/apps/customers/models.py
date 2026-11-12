"""Saved delivery addresses (Node: models/address.model.js)."""

from django.conf import settings
from django.core.validators import RegexValidator
from django.db import models

from apps.accounts.models import PHONE_PATTERN
from common.geo import PointField
from common.models import BaseModel, one_of

MAX_ADDRESSES_PER_USER = 10  # enforced in the service
POSTAL_CODE = RegexValidator(r"^[A-Za-z0-9 -]{3,10}$", "Invalid postal code")


class AddressLabel(models.TextChoices):
    HOME = "home"
    WORK = "work"
    OTHER = "other"


class Address(BaseModel):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="addresses"
    )
    label = models.CharField(max_length=8, choices=AddressLabel.choices, default=AddressLabel.HOME)
    recipient_name = models.CharField(max_length=80)
    phone = models.CharField(max_length=16, validators=[RegexValidator(PHONE_PATTERN)])
    line1 = models.CharField(max_length=120)
    line2 = models.CharField(max_length=120, blank=True, default="")
    area = models.CharField(max_length=80, blank=True, default="")
    landmark = models.CharField(max_length=80, blank=True, default="")
    city = models.CharField(max_length=60)
    state = models.CharField(max_length=60)
    postal_code = models.CharField(max_length=10, validators=[POSTAL_CODE])
    location = PointField()
    is_default = models.BooleanField(default=False)

    class Meta:
        db_table = "addresses"
        constraints = [
            # At most one default per customer (Node enforced this in code).
            models.UniqueConstraint(
                fields=["user"],
                condition=models.Q(is_default=True),
                name="addresses_one_default_per_user",
            ),
            one_of("label", AddressLabel, "addresses_label_valid"),
        ]
        indexes = [
            models.Index(
                fields=["user", "-is_default", "-updated_at"], name="addresses_user_default"
            )
        ]
