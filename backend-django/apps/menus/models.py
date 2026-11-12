"""Food categories and dishes (Node: models/food-category.model.js, models/food-item.model.js)."""

from django.core.validators import MaxValueValidator, MinValueValidator, RegexValidator
from django.db import models

from apps.restaurants.models import Restaurant
from common.models import BaseModel, RatingSummary

MIN_PRICE_PAISE = 100
MAX_PRICE_PAISE = 10_000_000


class FoodCategory(BaseModel):
    name = models.CharField(max_length=50)
    slug = models.SlugField(max_length=60, unique=True)
    description = models.CharField(max_length=300, blank=True, default="")
    # A Material icon name in the data; the web app maps it to a NexPrime icon.
    icon = models.CharField(
        max_length=40, default="restaurant", validators=[RegexValidator(r"^[a-z0-9_]+$")]
    )
    image_url = models.URLField(max_length=500, blank=True, default="")
    sort_order = models.PositiveIntegerField(default=0, validators=[MaxValueValidator(10_000)])
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "food_categories"
        indexes = [
            models.Index(fields=["is_active", "sort_order", "name"], name="food_categories_listing")
        ]
        verbose_name_plural = "food categories"

    def __str__(self) -> str:
        return self.name


class FoodItem(BaseModel, RatingSummary):
    restaurant = models.ForeignKey(Restaurant, on_delete=models.PROTECT, related_name="food_items")
    category = models.ForeignKey(FoodCategory, on_delete=models.PROTECT, related_name="food_items")
    name = models.CharField(max_length=100)
    description = models.CharField(max_length=500, blank=True, default="")
    price_paise = models.BigIntegerField(
        validators=[MinValueValidator(MIN_PRICE_PAISE), MaxValueValidator(MAX_PRICE_PAISE)]
    )
    is_veg = models.BooleanField()
    is_available = models.BooleanField(default=True)
    image_url = models.URLField(max_length=500, blank=True, default="")
    prep_time_minutes = models.PositiveSmallIntegerField(
        null=True, blank=True, validators=[MinValueValidator(1), MaxValueValidator(180)]
    )
    tags = models.JSONField(default=list)  # up to 10 lower-case strings
    deleted_at = models.DateTimeField(
        null=True, blank=True
    )  # soft delete: old orders keep their link

    class Meta:
        db_table = "food_items"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(
                    price_paise__gte=MIN_PRICE_PAISE, price_paise__lte=MAX_PRICE_PAISE
                ),
                name="food_items_price_range",
            ),
        ]
        indexes = [
            models.Index(
                fields=["restaurant", "deleted_at", "category"], name="food_items_restaurant_menu"
            ),
            models.Index(
                fields=["category", "deleted_at", "is_available"], name="food_items_category"
            ),
            models.Index(
                fields=["deleted_at", "is_available", "-created_at"], name="food_items_recent"
            ),
        ]

    def __str__(self) -> str:
        return self.name
