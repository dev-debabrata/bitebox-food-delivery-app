"""
Settlements and payouts (Node: `order.settlement`, `order.payouts`, models/payout.model.js).
Each delivered order gets one settlement row splitting the money; payouts pay those rows out.
"""

from django.conf import settings
from django.db import models

from apps.orders.models import Order
from apps.restaurants.models import Restaurant
from common.models import AppendOnlyModel, BaseModel, non_negative, one_of


class PayoutType(models.TextChoices):
    RESTAURANT = "restaurant"
    RIDER = "rider"


class PayoutStatus(models.TextChoices):
    PENDING = "pending"
    PAID = "paid"
    CANCELLED = "cancelled"


class Payout(BaseModel):
    type = models.CharField(max_length=10, choices=PayoutType.choices)
    restaurant = models.ForeignKey(
        Restaurant, on_delete=models.PROTECT, null=True, blank=True, related_name="payouts"
    )
    payee = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="payouts"
    )
    payee_name = models.CharField(max_length=100)
    orders_count = models.PositiveIntegerField(default=0)
    amount_paise = models.BigIntegerField(default=0)
    period_from = models.DateTimeField(null=True, blank=True)
    period_to = models.DateTimeField(null=True, blank=True)
    status = models.CharField(
        max_length=10, choices=PayoutStatus.choices, default=PayoutStatus.PENDING
    )
    reference = models.CharField(max_length=120, blank=True, default="")  # bank transfer reference
    note = models.CharField(max_length=500, blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )
    paid_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    paid_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "payouts"
        constraints = [
            one_of("type", PayoutType, "payouts_type_valid"),
            one_of("status", PayoutStatus, "payouts_status_valid"),
            non_negative("amount_paise", "payouts_amount_non_negative"),
            models.CheckConstraint(
                condition=~models.Q(type="restaurant") | models.Q(restaurant__isnull=False),
                name="payouts_restaurant_has_restaurant",
            ),
        ]
        indexes = [
            models.Index(fields=["type", "status", "-created_at"], name="payouts_type_status"),
            models.Index(fields=["payee", "-created_at"], name="payouts_payee_recent"),
        ]


class OrderSettlement(BaseModel):
    """How a delivered order's money splits. Written once by the workflow at delivery."""

    order = models.OneToOneField(Order, on_delete=models.PROTECT, related_name="settlement")
    restaurant_paise = models.BigIntegerField()
    rider_paise = models.BigIntegerField()
    platform_paise = models.BigIntegerField()  # may be negative when fees don't cover rider pay
    # The commission rate in effect at delivery (basis points of the food value after coupon).
    commission_bp = models.PositiveIntegerField(default=1500)
    # Refunds after delivery taken from the restaurant's share (while not yet paid out).
    refund_adjustment_paise = models.BigIntegerField(default=0)
    settled_at = models.DateTimeField()
    # Claimed by a payout (null = still due).
    restaurant_payout = models.ForeignKey(
        Payout,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="restaurant_settlements",
    )
    rider_payout = models.ForeignKey(
        Payout, on_delete=models.SET_NULL, null=True, blank=True, related_name="rider_settlements"
    )

    class Meta:
        db_table = "order_settlements"
        constraints = [
            non_negative("restaurant_paise", "order_settlements_restaurant_non_negative"),
            non_negative("rider_paise", "order_settlements_rider_non_negative"),
        ]
        indexes = [
            models.Index(fields=["settled_at"], name="order_settlements_settled"),
            models.Index(fields=["restaurant_payout"], name="order_settlements_rest_payout"),
            models.Index(fields=["rider_payout"], name="order_settlements_rider_payout"),
        ]


class CommissionRule(BaseModel):
    """
    The restaurant commission (basis points of the food value after the coupon). A rule with no
    restaurant is the global rate; a restaurant's own rule overrides it. Changing a rate closes the
    current rule (`effective_to`) and opens a new one, so history and audits keep every rate.
    """

    restaurant = models.ForeignKey(
        Restaurant,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="commission_rules",
    )
    basis_points = models.PositiveIntegerField()
    effective_from = models.DateTimeField()
    effective_to = models.DateTimeField(null=True, blank=True)
    note = models.CharField(max_length=300, blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )

    class Meta:
        db_table = "commission_rules"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(basis_points__lte=10_000), name="commission_rules_bp_range"
            ),
            # One open rule per scope (the global scope is restaurant NULL).
            models.UniqueConstraint(
                fields=["restaurant"],
                condition=models.Q(effective_to__isnull=True),
                nulls_distinct=False,
                name="commission_rules_one_open",
            ),
        ]


class LedgerAccount(models.TextChoices):
    CUSTOMER_PAYMENTS = "customer_payments"  # money collected from customers
    RESTAURANT_PAYABLE = "restaurant_payable"  # owed to restaurants
    RIDER_PAYABLE = "rider_payable"  # owed to riders
    PLATFORM_REVENUE = "platform_revenue"  # BiteBox's share (fees and commission)
    TAX_PAYABLE = "tax_payable"  # tax collected on orders
    PAYOUTS = "payouts"  # money paid out to partners


class LedgerEntry(AppendOnlyModel):
    """
    Double-entry finance ledger (append-only; a database trigger refuses edits and deletes).
    Each financial event is one `entry_group` whose amounts sum to zero; amounts are signed
    (positive = money in or a debt settled, negative = money out or a debt created).
    """

    entry_group = models.UUIDField()
    key = models.CharField(max_length=120)  # the event, e.g. settle:<orderId> (idempotency)
    account = models.CharField(max_length=24, choices=LedgerAccount.choices)
    amount_paise = models.BigIntegerField()
    order = models.ForeignKey(
        Order, on_delete=models.PROTECT, null=True, blank=True, related_name="ledger_entries"
    )
    payout = models.ForeignKey(
        Payout, on_delete=models.PROTECT, null=True, blank=True, related_name="ledger_entries"
    )
    description = models.CharField(max_length=200, blank=True, default="")

    class Meta:
        db_table = "ledger_entries"
        constraints = [
            one_of("account", LedgerAccount, "ledger_entries_account_valid"),
            models.UniqueConstraint(fields=["key", "account"], name="ledger_entries_once"),
        ]
        indexes = [
            models.Index(fields=["entry_group"], name="ledger_entries_group"),
            models.Index(fields=["account", "-created_at"], name="ledger_entries_account"),
        ]


class InvoiceKind(models.TextChoices):
    CUSTOMER_TAX_INVOICE = "customer_tax_invoice"  # an order's invoice for the customer
    PAYOUT_STATEMENT = "payout_statement"  # what a restaurant or rider was paid, and for what


class Invoice(BaseModel):
    """A numbered document (series per Indian financial year); the PDF is built on request."""

    kind = models.CharField(max_length=24, choices=InvoiceKind.choices)
    number = models.CharField(max_length=40, unique=True)
    order = models.OneToOneField(
        Order, on_delete=models.PROTECT, null=True, blank=True, related_name="invoice"
    )
    payout = models.OneToOneField(
        Payout, on_delete=models.PROTECT, null=True, blank=True, related_name="statement"
    )
    amount_paise = models.BigIntegerField()
    tax_paise = models.BigIntegerField(default=0)
    issued_at = models.DateTimeField()

    class Meta:
        db_table = "invoices"
        constraints = [one_of("kind", InvoiceKind, "invoices_kind_valid")]


class InvoiceSequence(models.Model):
    """The last number used per series (e.g. "INV/2026-27"), taken under a row lock."""

    series = models.CharField(max_length=20, primary_key=True)
    last = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "invoice_sequences"

    def __str__(self) -> str:
        return f"{self.series} #{self.last}"
