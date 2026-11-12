"""
Support tickets (Node: models/support-ticket.model.js). Messages and history are rows; internal
notes are messages with `internal=True`, which requester queries must always exclude.
"""

from django.conf import settings
from django.db import models

from common.models import AppendOnlyModel, BaseModel, one_of


class TicketStatus(models.TextChoices):
    OPEN = "open"
    IN_PROGRESS = "in_progress"
    WAITING_FOR_RESPONSE = "waiting_for_response"
    RESOLVED = "resolved"
    CLOSED = "closed"


OPEN_TICKET_STATUSES = (
    TicketStatus.OPEN,
    TicketStatus.IN_PROGRESS,
    TicketStatus.WAITING_FOR_RESPONSE,
)


class TicketPriority(models.TextChoices):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    URGENT = "urgent"


class TicketType(models.TextChoices):
    ORDER_ISSUE = "order_issue"
    DELIVERY = "delivery"
    PAYMENT = "payment"
    REFUND = "refund"
    ACCOUNT = "account"
    OTHER = "other"


class RequesterRole(models.TextChoices):
    CUSTOMER = "customer"
    RESTAURANT = "restaurant"
    DELIVERY = "delivery"


class SupportTicket(BaseModel):
    number = models.CharField(max_length=24, unique=True)
    raised_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="tickets"
    )
    requester_role = models.CharField(max_length=12, choices=RequesterRole.choices)
    requester_name = models.CharField(max_length=80)
    type = models.CharField(max_length=12, choices=TicketType.choices)
    subject = models.CharField(max_length=120)
    order = models.ForeignKey(
        "orders.Order", on_delete=models.SET_NULL, null=True, blank=True, related_name="tickets"
    )
    order_number = models.CharField(max_length=24, blank=True, default="")
    priority = models.CharField(
        max_length=8, choices=TicketPriority.choices, default=TicketPriority.MEDIUM
    )
    status = models.CharField(
        max_length=20, choices=TicketStatus.choices, default=TicketStatus.OPEN
    )
    assignee = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="assigned_tickets",
    )
    last_activity_at = models.DateTimeField(auto_now_add=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "support_tickets"
        constraints = [
            one_of("status", TicketStatus, "support_tickets_status_valid"),
            one_of("priority", TicketPriority, "support_tickets_priority_valid"),
            one_of("type", TicketType, "support_tickets_type_valid"),
            one_of("requester_role", RequesterRole, "support_tickets_requester_valid"),
        ]
        indexes = [
            models.Index(
                fields=["status", "priority", "-last_activity_at"], name="support_tickets_queue"
            ),
            models.Index(
                fields=["requester_role", "status", "-last_activity_at"],
                name="support_tickets_by_role",
            ),
            models.Index(
                fields=["raised_by", "-last_activity_at"], name="support_tickets_requester"
            ),
            models.Index(fields=["assignee", "status"], name="support_tickets_assignee"),
        ]


class SupportMessage(AppendOnlyModel):
    ticket = models.ForeignKey(SupportTicket, on_delete=models.CASCADE, related_name="messages")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    author_role = models.CharField(max_length=24)
    author_name = models.CharField(max_length=80)
    body = models.CharField(max_length=2000)
    internal = models.BooleanField(default=False)  # staff-only note

    class Meta:
        db_table = "support_messages"
        ordering = ["created_at"]
        indexes = [models.Index(fields=["ticket", "created_at"], name="support_messages_thread")]


class SupportTicketEvent(AppendOnlyModel):
    """Status, priority, assignment and escalation changes (Node: ticket.history)."""

    ticket = models.ForeignKey(SupportTicket, on_delete=models.CASCADE, related_name="history")
    action = models.CharField(max_length=40)
    from_value = models.CharField(max_length=80, blank=True, default="")
    to_value = models.CharField(max_length=80, blank=True, default="")
    note = models.CharField(max_length=500, blank=True, default="")
    by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    by_name = models.CharField(max_length=80, blank=True, default="")

    class Meta:
        db_table = "support_ticket_history"
        ordering = ["created_at"]
