"""
Restaurants (Node: models/restaurant.model.js).
KYC, weekly hours and bank details come in later phases.
"""

from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator, RegexValidator
from django.db import models

from apps.accounts.models import PHONE_PATTERN
from apps.customers.models import POSTAL_CODE
from common.geo import PointField
from common.models import BaseModel, RatingSummary, non_negative, one_of

TIME_OF_DAY = RegexValidator(r"^([01]\d|2[0-3]):[0-5]\d$", "Use HH:MM (24-hour)")
MAX_MONEY_PAISE = 10_000_000


class RestaurantStatus(models.TextChoices):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    SUSPENDED = "suspended"


# Which status changes an admin may make (Node ADMIN_STATUS_TRANSITIONS).
ADMIN_STATUS_TRANSITIONS: dict[str, frozenset[str]] = {
    RestaurantStatus.PENDING: frozenset({RestaurantStatus.APPROVED, RestaurantStatus.REJECTED}),
    RestaurantStatus.APPROVED: frozenset({RestaurantStatus.SUSPENDED}),
    RestaurantStatus.SUSPENDED: frozenset({RestaurantStatus.APPROVED}),
    RestaurantStatus.REJECTED: frozenset({RestaurantStatus.APPROVED}),
}


class Restaurant(BaseModel, RatingSummary):
    owner = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="restaurant"
    )
    name = models.CharField(max_length=100)
    slug = models.SlugField(max_length=120, unique=True)
    description = models.CharField(max_length=1000, blank=True, default="")
    cuisines = models.JSONField(default=list)  # 1–10 strings; GIN-indexed on PostgreSQL
    phone = models.CharField(max_length=16, validators=[RegexValidator(PHONE_PATTERN)])
    email = models.EmailField(max_length=254, blank=True, default="")
    # Address (an embedded document in Node), flattened
    line1 = models.CharField(max_length=120)
    line2 = models.CharField(max_length=120, blank=True, default="")
    area = models.CharField(max_length=80, blank=True, default="")
    city = models.CharField(max_length=60)
    state = models.CharField(max_length=60)
    postal_code = models.CharField(max_length=10, validators=[POSTAL_CODE])
    location = PointField()
    image_url = models.URLField(max_length=500, blank=True, default="")
    is_pure_veg = models.BooleanField(default=False)
    cost_for_two_paise = models.BigIntegerField(validators=[MaxValueValidator(MAX_MONEY_PAISE)])
    min_order_paise = models.BigIntegerField(
        default=0, validators=[MaxValueValidator(MAX_MONEY_PAISE)]
    )
    avg_prep_time_minutes = models.PositiveSmallIntegerField(
        default=25, validators=[MinValueValidator(5), MaxValueValidator(180)]
    )
    # Daily hours (one slot) in `timezone`. Weekly slots and holidays replace these in release 2.
    opening_time = models.CharField(max_length=5, validators=[TIME_OF_DAY])
    closing_time = models.CharField(max_length=5, validators=[TIME_OF_DAY])
    timezone = models.CharField(max_length=60, default="Asia/Kolkata")
    is_accepting_orders = models.BooleanField(default=True)
    status = models.CharField(
        max_length=24, choices=RestaurantStatus.choices, default=RestaurantStatus.PENDING
    )
    status_reason = models.CharField(max_length=500, blank=True, default="")
    reviewed_at = models.DateTimeField(null=True, blank=True)
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    class Meta:
        db_table = "restaurants"
        constraints = [
            one_of("status", RestaurantStatus, "restaurants_status_valid"),
            non_negative("cost_for_two_paise", "restaurants_cost_for_two_non_negative"),
            non_negative("min_order_paise", "restaurants_min_order_non_negative"),
        ]
        indexes = [
            models.Index(fields=["status", "-rating_average"], name="restaurants_status_rating"),
            models.Index(fields=["status", "-created_at"], name="restaurants_status_created"),
        ]

    def __str__(self) -> str:
        return self.name
