"""
One cart per customer, for one restaurant (Node: models/cart.model.js).
Variants and add-ons come in release 2.
"""

from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models

from apps.menus.models import FoodItem
from apps.restaurants.models import Restaurant
from common.models import BaseModel

MAX_CART_LINES = 30  # enforced in the service
MAX_ITEM_QUANTITY = 20


class Cart(BaseModel):
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="cart"
    )
    restaurant = models.ForeignKey(
        Restaurant, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    coupon_code = models.CharField(max_length=30, blank=True, default="")
    coins_to_redeem = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "carts"


class CartItem(BaseModel):
    cart = models.ForeignKey(Cart, on_delete=models.CASCADE, related_name="items")
    food_item = models.ForeignKey(FoodItem, on_delete=models.CASCADE, related_name="+")
    quantity = models.PositiveSmallIntegerField(
        validators=[MinValueValidator(1), MaxValueValidator(MAX_ITEM_QUANTITY)]
    )

    class Meta:
        db_table = "cart_items"
        constraints = [
            models.UniqueConstraint(
                fields=["cart", "food_item"], name="cart_items_one_line_per_dish"
            ),
            models.CheckConstraint(
                condition=models.Q(quantity__gte=1, quantity__lte=MAX_ITEM_QUANTITY),
                name="cart_items_quantity_range",
            ),
        ]
