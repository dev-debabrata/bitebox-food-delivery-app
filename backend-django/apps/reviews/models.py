"""
Reviews of a restaurant, a dish or a rider, one per target per order (Node: models/review.model.js).
Edits and moderation decisions are kept as their own rows (Node: embedded arrays).
"""

from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models

from apps.menus.models import FoodItem
from apps.orders.models import Order
from apps.restaurants.models import Restaurant
from common.models import AppendOnlyModel, BaseModel, one_of

COMMENT_MAX = 1000
RESPONSE_MAX = 1000
REPORT_NOTE_MAX = 300
MODERATION_REASON_MAX = 300
MAX_IMAGES = 5
# Node: config/reviews.js REVIEW_POLICY
SUBMIT_WINDOW_DAYS = 30  # after delivery
EDIT_WINDOW_DAYS = 30  # after posting
MIN_REVIEWS_TO_RANK = 3  # admin analytics: top and bottom lists
STARS = [MinValueValidator(1), MaxValueValidator(5)]


class ReviewTarget(models.TextChoices):
    RESTAURANT = "restaurant"
    FOOD = "food"
    RIDER = "rider"


class ReviewStatus(models.TextChoices):
    PUBLISHED = "published"
    HIDDEN = "hidden"  # by a moderator; can be restored
    REMOVED = "removed"  # by a moderator; final
    DELETED = "deleted"  # by the customer; final


class ModerationAction(models.TextChoices):
    HIDE = "hide"
    REMOVE = "remove"
    RESTORE = "restore"
    DISMISS_REPORTS = "dismiss_reports"


class Review(BaseModel):
    target = models.CharField(max_length=10, choices=ReviewTarget.choices)
    customer = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="reviews"
    )
    customer_name = models.CharField(max_length=80)
    order = models.ForeignKey(Order, on_delete=models.PROTECT, related_name="reviews")
    order_number = models.CharField(max_length=24)
    restaurant = models.ForeignKey(Restaurant, on_delete=models.PROTECT, related_name="reviews")
    food_item = models.ForeignKey(
        FoodItem, on_delete=models.PROTECT, null=True, blank=True, related_name="reviews"
    )
    food_name = models.CharField(max_length=100, blank=True, default="")
    delivery_partner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="rider_reviews",
    )
    rating = models.PositiveSmallIntegerField(validators=STARS)
    comment = models.CharField(max_length=COMMENT_MAX, blank=True, default="")
    images = models.JSONField(default=list)  # up to MAX_IMAGES URLs
    status = models.CharField(
        max_length=10, choices=ReviewStatus.choices, default=ReviewStatus.PUBLISHED
    )
    edited_at = models.DateTimeField(null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True)
    open_reports = models.PositiveIntegerField(default=0)
    # Latest moderation decision (the full history is ReviewModeration)
    moderation_action = models.CharField(
        max_length=16, choices=ModerationAction.choices, blank=True, default=""
    )
    moderation_reason = models.CharField(max_length=MODERATION_REASON_MAX, blank=True, default="")
    moderated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "reviews"
        constraints = [
            one_of("target", ReviewTarget, "reviews_target_valid"),
            one_of("status", ReviewStatus, "reviews_status_valid"),
            models.CheckConstraint(
                condition=models.Q(rating__gte=1, rating__lte=5), name="reviews_rating_1_to_5"
            ),
            # One review per target per order (a dish target is per dish).
            models.UniqueConstraint(
                fields=["order", "target"],
                condition=models.Q(food_item__isnull=True),
                name="reviews_once_per_target",
            ),
            models.UniqueConstraint(
                fields=["order", "target", "food_item"],
                condition=models.Q(food_item__isnull=False),
                name="reviews_once_per_dish",
            ),
            models.CheckConstraint(
                condition=~models.Q(target="food") | models.Q(food_item__isnull=False),
                name="reviews_food_has_dish",
            ),
            models.CheckConstraint(
                condition=~models.Q(target="rider") | models.Q(delivery_partner__isnull=False),
                name="reviews_rider_has_rider",
            ),
        ]
        indexes = [
            models.Index(fields=["customer", "-created_at"], name="reviews_customer_recent"),
            models.Index(
                fields=["target", "restaurant", "status", "-created_at"], name="reviews_restaurant"
            ),
            models.Index(
                fields=["target", "restaurant", "status", "rating"],
                name="reviews_restaurant_rating",
            ),
            models.Index(fields=["food_item", "status", "-created_at"], name="reviews_food"),
            models.Index(
                fields=["delivery_partner", "status", "-created_at"], name="reviews_rider"
            ),
            models.Index(fields=["open_reports", "status"], name="reviews_reported"),
            models.Index(fields=["-created_at"], name="reviews_recent"),
        ]


class ReviewResponse(BaseModel):
    """The restaurant's public reply (one per review)."""

    review = models.OneToOneField(Review, on_delete=models.CASCADE, related_name="response")
    text = models.CharField(max_length=RESPONSE_MAX)
    responded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "review_responses"


class ReviewEdit(AppendOnlyModel):
    """What a review said before an edit (hidden from the public)."""

    review = models.ForeignKey(Review, on_delete=models.CASCADE, related_name="edits")
    rating = models.PositiveSmallIntegerField(validators=STARS)
    comment = models.CharField(max_length=COMMENT_MAX, blank=True, default="")
    images = models.JSONField(default=list)
    replaced_at = models.DateTimeField()

    class Meta:
        db_table = "review_edits"


class ReviewModeration(AppendOnlyModel):
    review = models.ForeignKey(Review, on_delete=models.CASCADE, related_name="moderation_log")
    action = models.CharField(max_length=16, choices=ModerationAction.choices)
    reason = models.CharField(max_length=MODERATION_REASON_MAX)
    from_status = models.CharField(
        max_length=10, choices=ReviewStatus.choices, blank=True, default=""
    )
    to_status = models.CharField(
        max_length=10, choices=ReviewStatus.choices, blank=True, default=""
    )
    by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")

    class Meta:
        db_table = "review_moderation_log"
        constraints = [one_of("action", ModerationAction, "review_moderation_action_valid")]


class ReportReason(models.TextChoices):
    SPAM = "spam"
    OFFENSIVE = "offensive"
    HARASSMENT = "harassment"
    PERSONAL_INFO = "personal_info"
    IRRELEVANT = "irrelevant"
    FAKE = "fake"
    OTHER = "other"


class ReportStatus(models.TextChoices):
    OPEN = "open"
    ACTIONED = "actioned"
    DISMISSED = "dismissed"


class ReviewReport(BaseModel):
    review = models.ForeignKey(Review, on_delete=models.CASCADE, related_name="reports")
    reporter = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )
    reporter_role = models.CharField(max_length=24)
    reason = models.CharField(max_length=16, choices=ReportReason.choices)
    note = models.CharField(max_length=REPORT_NOTE_MAX, blank=True, default="")
    status = models.CharField(
        max_length=10, choices=ReportStatus.choices, default=ReportStatus.OPEN
    )
    resolved_at = models.DateTimeField(null=True, blank=True)
    resolved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    class Meta:
        db_table = "review_reports"
        constraints = [
            models.UniqueConstraint(
                fields=["review", "reporter"], name="review_reports_once_per_reporter"
            ),
            one_of("reason", ReportReason, "review_reports_reason_valid"),
            one_of("status", ReportStatus, "review_reports_status_valid"),
        ]
        indexes = [
            models.Index(fields=["review", "status"], name="review_reports_review"),
            models.Index(fields=["status", "-created_at"], name="review_reports_queue"),
        ]
