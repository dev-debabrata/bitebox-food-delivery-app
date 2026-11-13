"""
Orders (Node: models/order.model.js). Prices, the address and the restaurant are snapshots taken
when the order is placed; later menu or address edits never change a placed order.

Status changes happen only in orders.workflow (Phase 7), with a conditional update
("still in status X"); never assign `status` anywhere else.
"""

from django.conf import settings
from django.db import models

from apps.menus.models import FoodItem
from apps.restaurants.models import Restaurant
from common.geo import PointField
from common.models import AppendOnlyModel, BaseModel, non_negative, one_of


class OrderStatus(models.TextChoices):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    PREPARING = "preparing"
    READY_FOR_PICKUP = "ready_for_pickup"
    ASSIGNED = "assigned"
    ARRIVED_AT_RESTAURANT = "arrived_at_restaurant"  # the rider is at the restaurant (D3)
    PICKED_UP = "picked_up"
    ON_THE_WAY = "on_the_way"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"


S = OrderStatus
ACTIVE_STATUSES = (
    S.PENDING,
    S.CONFIRMED,
    S.PREPARING,
    S.READY_FOR_PICKUP,
    S.ASSIGNED,
    S.ARRIVED_AT_RESTAURANT,
    S.PICKED_UP,
    S.ON_THE_WAY,
)
FINAL_STATUSES = (S.DELIVERED, S.REJECTED, S.CANCELLED)
TRACKED_STATUSES = (S.ASSIGNED, S.ARRIVED_AT_RESTAURANT, S.PICKED_UP, S.ON_THE_WAY)


class PaymentMethod(models.TextChoices):
    COD = "cod"
    ONLINE = "online"


class PaymentStatus(models.TextChoices):
    PENDING = "pending"
    PAID = "paid"
    FAILED = "failed"
    REFUNDED = "refunded"
    PARTIALLY_REFUNDED = "partially_refunded"  # decision D3
    CANCELLED = "cancelled"


class CoinState(models.TextChoices):
    RESERVED = "reserved"
    COMMITTED = "committed"
    RELEASED = "released"
    REFUNDED = "refunded"


class Order(BaseModel):
    order_number = models.CharField(max_length=24, unique=True)
    customer = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="orders"
    )
    restaurant = models.ForeignKey(Restaurant, on_delete=models.PROTECT, related_name="orders")
    # {name, slug, phone, address, location: {lat, lng}}
    restaurant_snapshot = models.JSONField()
    # {label, recipientName, phone, line1, line2, area, landmark, city, state, postalCode}
    delivery_address = models.JSONField()
    delivery_location = PointField()

    # Pricing (server-computed; see the check constraint for how they add up)
    subtotal_paise = models.BigIntegerField()
    discount_paise = models.BigIntegerField(default=0)  # coupon
    delivery_fee_paise = models.BigIntegerField()
    platform_fee_paise = models.BigIntegerField()
    tax_paise = models.BigIntegerField()
    coin_discount_paise = models.BigIntegerField(
        default=0
    )  # Node pricing.coinDiscountPaise (= coins.discountPaise)
    total_paise = models.BigIntegerField()
    coupon_code = models.CharField(max_length=30, blank=True, default="")

    coins_redeemed = models.PositiveIntegerField(default=0)
    coins_state = models.CharField(max_length=10, choices=CoinState.choices, null=True, blank=True)
    coins_earned = models.PositiveIntegerField(default=0)

    distance_m = models.PositiveIntegerField()  # straight-line, restaurant → delivery point
    note = models.CharField(max_length=300, blank=True, default="")

    status = models.CharField(
        max_length=24, choices=OrderStatus.choices, default=OrderStatus.PENDING
    )
    status_changed_at = models.DateTimeField(auto_now_add=True)  # the sweeps time out from this
    payment_method = models.CharField(max_length=8, choices=PaymentMethod.choices)
    payment_status = models.CharField(
        max_length=20, choices=PaymentStatus.choices, default=PaymentStatus.PENDING
    )
    # Null until an online order is paid: restaurants never see unpaid orders, and their
    # response timer starts here.
    submitted_at = models.DateTimeField(null=True, blank=True)

    delivery_partner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="deliveries",
    )
    idempotency_key = models.CharField(max_length=100, null=True, blank=True)

    # Set by the restaurant when it accepts: how long the food takes, and when it should be ready.
    prep_minutes = models.PositiveSmallIntegerField(null=True, blank=True)
    ready_by = models.DateTimeField(null=True, blank=True)
    # Straight-line metres from the rider's last fix to the restaurant when they marked "arrived"
    # (null without a fix). Far arrivals are allowed but flagged for admins.
    arrival_distance_m = models.PositiveIntegerField(null=True, blank=True)
    # When the customer was told the rider is close (once per order).
    approach_notified_at = models.DateTimeField(null=True, blank=True)

    # Delivery OTP (master prompt §6 step 23): created when the rider picks the order up, shown to
    # the customer only, and required to mark it delivered. Wrong tries are counted and capped.
    delivery_otp = models.CharField(max_length=6, blank=True, default="")
    delivery_otp_attempts = models.PositiveSmallIntegerField(default=0)

    class Meta:
        db_table = "orders"
        constraints = [
            one_of("status", OrderStatus, "orders_status_valid"),
            one_of("payment_method", PaymentMethod, "orders_payment_method_valid"),
            one_of("payment_status", PaymentStatus, "orders_payment_status_valid"),
            *(
                non_negative(f, f"orders_{f}_non_negative")
                for f in (
                    "subtotal_paise",
                    "discount_paise",
                    "delivery_fee_paise",
                    "platform_fee_paise",
                    "tax_paise",
                    "coin_discount_paise",
                    "total_paise",
                )
            ),
            # Same arithmetic as the Node pricing service (computePricing).
            models.CheckConstraint(
                condition=models.Q(
                    total_paise=models.F("subtotal_paise")
                    - models.F("discount_paise")
                    + models.F("delivery_fee_paise")
                    + models.F("platform_fee_paise")
                    + models.F("tax_paise")
                    - models.F("coin_discount_paise")
                ),
                name="orders_total_adds_up",
            ),
            models.CheckConstraint(
                condition=models.Q(discount_paise__lte=models.F("subtotal_paise")),
                name="orders_discount_within_subtotal",
            ),
            # Placing the same order twice (double tap, retry) returns the first one.
            models.UniqueConstraint(
                fields=["customer", "idempotency_key"],
                condition=models.Q(idempotency_key__isnull=False),
                name="orders_idempotency_per_customer",
            ),
        ]
        indexes = [
            models.Index(fields=["customer", "-created_at"], name="orders_customer_recent"),
            models.Index(
                fields=["restaurant", "status", "-created_at"], name="orders_restaurant_status"
            ),
            models.Index(fields=["status", "-created_at"], name="orders_status_recent"),
            models.Index(
                fields=["delivery_partner", "status", "-created_at"], name="orders_rider_status"
            ),
            models.Index(fields=["status", "status_changed_at"], name="orders_sweep"),
        ]

    def __str__(self) -> str:
        return self.order_number


class OrderItem(BaseModel):
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="items")
    food_item = models.ForeignKey(FoodItem, on_delete=models.PROTECT, related_name="+")
    name = models.CharField(max_length=100)
    is_veg = models.BooleanField()
    unit_price_paise = models.BigIntegerField()
    quantity = models.PositiveSmallIntegerField()
    line_total_paise = models.BigIntegerField()

    class Meta:
        db_table = "order_items"
        constraints = [
            non_negative("unit_price_paise", "order_items_unit_price_non_negative"),
            models.CheckConstraint(
                condition=models.Q(quantity__gte=1), name="order_items_quantity_positive"
            ),
            models.CheckConstraint(
                condition=models.Q(
                    line_total_paise=models.F("unit_price_paise") * models.F("quantity")
                ),
                name="order_items_line_total",
            ),
        ]


class OrderStatusHistory(AppendOnlyModel):
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="status_history")
    from_status = models.CharField(
        max_length=24, choices=OrderStatus.choices, null=True, blank=True
    )
    to_status = models.CharField(max_length=24, choices=OrderStatus.choices)
    actor_role = models.CharField(
        max_length=12, blank=True, default=""
    )  # customer, restaurant, delivery, admin, system
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    note = models.CharField(max_length=300, blank=True, default="")

    class Meta:
        db_table = "order_status_history"
        ordering = ["created_at"]
        indexes = [models.Index(fields=["order", "created_at"], name="order_history_timeline")]


class CancelledBy(models.TextChoices):
    CUSTOMER = "customer"
    RESTAURANT = "restaurant"
    ADMIN = "admin"
    SYSTEM = "system"


class OrderCancellation(BaseModel):
    order = models.OneToOneField(Order, on_delete=models.CASCADE, related_name="cancellation")
    by = models.CharField(max_length=12, choices=CancelledBy.choices)
    reason = models.CharField(max_length=300, blank=True, default="")

    class Meta:
        db_table = "order_cancellations"
        constraints = [one_of("by", CancelledBy, "order_cancellations_by_valid")]
