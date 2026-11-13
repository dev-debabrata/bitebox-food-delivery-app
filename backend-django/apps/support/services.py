"""
Support tickets (Node: services/support.service.js). Customers, restaurants and riders raise and
follow their own tickets; support staff assign, reply, add internal notes and escalate to finance.
Requesters never see internal notes or staff names (staff show as "BiteBox Support"). Every
status, priority, assignment and escalation change is kept in the ticket history.
"""

import secrets
import uuid
from datetime import datetime
from typing import Any

from django.db import transaction
from django.db.models import Count, Q, QuerySet
from django.utils import timezone

from apps.accounts.models import User, UserStatus
from apps.notifications.services import notify, notify_admins
from apps.orders.models import Order
from apps.rbac.roles import ADMIN_ROLES, Permission, Role, has_permission
from common.api import ApiError
from common.pagination import Page, paginate

from .models import (
    OPEN_TICKET_STATUSES,
    RequesterRole,
    SupportMessage,
    SupportTicket,
    SupportTicketEvent,
    TicketPriority,
    TicketStatus,
    TicketType,
)

T = TicketStatus
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O or 1/I
SUPPORT_NAME = "BiteBox Support"
STATUS_LABEL = {
    T.OPEN: "Open",
    T.IN_PROGRESS: "In progress",
    T.WAITING_FOR_RESPONSE: "Waiting for your reply",
    T.RESOLVED: "Resolved",
    T.CLOSED: "Closed",
}
# Where the person who raised a ticket reads it in the web app.
REQUESTER_LINK = {
    RequesterRole.CUSTOMER: "/support/{}",
    RequesterRole.RESTAURANT: "/restaurant/support/{}",
    RequesterRole.DELIVERY: "/delivery/support/{}",
}
OPEN = list(OPEN_TICKET_STATUSES)


def _staff_link(ticket: SupportTicket) -> str:
    return f"/admin/support/ticket/{ticket.pk}"


def _requester_link(ticket: SupportTicket) -> str:
    return REQUESTER_LINK[RequesterRole(ticket.requester_role)].format(ticket.pk)


def _is_staff(role: str) -> bool:
    return role in ADMIN_ROLES


def ticket_number(now: datetime | None = None) -> str:
    """`TK-YYMMDD-XXXXXX` (Node: utils/codes.js#randomCode("TK"))."""
    now = now or timezone.now()
    suffix = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
    return f"TK-{now:%y%m%d}-{suffix}"


def _own_order(user: User, order_number: str | None) -> Order | None:
    """The requester may only attach an order they placed, cooked or carried."""
    if not order_number:
        return None
    scope = Q(order_number=order_number.upper())
    if user.role == Role.CUSTOMER:
        scope &= Q(customer=user)
    elif user.role == Role.DELIVERY:
        scope &= Q(delivery_partner=user)
    else:
        scope &= Q(restaurant__owner=user)
    order = Order.objects.filter(scope).only("id", "order_number").first()
    if order is None:
        raise ApiError(
            422,
            "We could not find that order on your account",
            code="VALIDATION_ERROR",
            details=[{"field": "orderNumber", "message": "No matching order on your account"}],
        )
    return order


def _event(
    ticket: SupportTicket,
    user: User,
    action: str,
    *,
    from_value: str = "",
    to_value: str = "",
    note: str = "",
) -> SupportTicketEvent:
    return SupportTicketEvent(
        ticket=ticket,
        action=action,
        from_value=from_value,
        to_value=to_value,
        note=note or "",
        by=user,
        by_name=user.name,
    )


def _message(
    ticket: SupportTicket, user: User, body: str, internal: bool = False
) -> SupportMessage:
    return SupportMessage.objects.create(
        ticket=ticket,
        author=user,
        author_role=user.role,
        author_name=user.name,
        body=body,
        internal=internal,
    )


def _save_events(events: list[SupportTicketEvent]) -> None:
    # One at a time so each row gets its own (increasing) created_at.
    for event in events:
        event.save()


# ---------------------------------------------------------------------------
# Presentation
# ---------------------------------------------------------------------------
def _requester_view(ticket: SupportTicket, with_messages: bool = True) -> dict[str, Any]:
    messages = (
        ticket.messages.filter(internal=False).order_by("created_at", "id") if with_messages else []
    )
    return {
        "id": str(ticket.pk),
        "number": ticket.number,
        "type": ticket.type,
        "subject": ticket.subject,
        "status": ticket.status,
        "orderNumber": ticket.order_number or None,
        "createdAt": ticket.created_at,
        "lastActivityAt": ticket.last_activity_at,
        "messages": [
            {
                "id": str(m.pk),
                "fromSupport": _is_staff(m.author_role),
                # Staff names stay private; requesters see "BiteBox Support".
                "authorName": SUPPORT_NAME if _is_staff(m.author_role) else m.author_name,
                "body": m.body,
                "at": m.created_at,
            }
            for m in messages
        ],
    }


def _assignee(ticket: SupportTicket) -> dict[str, str] | None:
    a = ticket.assignee
    return {"id": str(a.pk), "name": a.name} if a is not None and a.name else None


def _staff_summary(ticket: SupportTicket, message_count: int) -> dict[str, Any]:
    return {
        "id": str(ticket.pk),
        "number": ticket.number,
        "type": ticket.type,
        "subject": ticket.subject,
        "status": ticket.status,
        "priority": ticket.priority,
        "requesterRole": ticket.requester_role,
        "requesterName": ticket.requester_name,
        "orderNumber": ticket.order_number or None,
        "assignee": _assignee(ticket),
        "messages": message_count,
        "createdAt": ticket.created_at,
        "lastActivityAt": ticket.last_activity_at,
    }


def _history_json(e: SupportTicketEvent) -> dict[str, Any]:
    row: dict[str, Any] = {"action": e.action}
    if e.from_value:
        row["from"] = e.from_value
    if e.to_value:
        row["to"] = e.to_value
    if e.note:
        row["note"] = e.note
    if e.by_id:
        row["by"] = str(e.by_id)
    if e.by_name:
        row["byName"] = e.by_name
    row["at"] = e.created_at
    return row


def _staff_view(ticket_id: uuid.UUID) -> dict[str, Any]:
    ticket = SupportTicket.objects.select_related("assignee", "raised_by", "order").get(
        pk=ticket_id
    )
    messages = list(ticket.messages.order_by("created_at", "id"))
    history = list(ticket.history.order_by("created_at", "id"))
    r = ticket.raised_by
    o = ticket.order
    return {
        **_staff_summary(ticket, len(messages)),
        "requester": {
            "id": str(r.pk),
            "name": r.name,
            "email": r.email,
            "phone": r.phone or None,
            "role": r.role,
        },
        "order": (
            {
                "id": str(o.pk),
                "orderNumber": o.order_number,
                "status": o.status,
                "totalPaise": o.total_paise,
                "paymentMethod": o.payment_method,
                "paymentStatus": o.payment_status,
                "restaurantName": (o.restaurant_snapshot or {}).get("name"),
                "createdAt": o.created_at,
            }
            if o is not None
            else None
        ),
        "messages": [
            {
                "id": str(m.pk),
                "authorName": m.author_name,
                "authorRole": m.author_role,
                "fromSupport": _is_staff(m.author_role),
                "internal": m.internal,
                "body": m.body,
                "at": m.created_at,
            }
            for m in messages
        ],
        "history": [_history_json(e) for e in history],
        "resolvedAt": ticket.resolved_at,
        "closedAt": ticket.closed_at,
    }


# ---------------------------------------------------------------------------
# Customers, restaurants and riders
# ---------------------------------------------------------------------------
def create(user: User, data: dict[str, Any]) -> dict[str, Any]:
    order = _own_order(user, data.get("order_number"))
    kind = data["type"]
    with transaction.atomic():
        ticket = SupportTicket.objects.create(
            number=ticket_number(),
            raised_by=user,
            requester_role=user.role,
            requester_name=user.name,
            type=kind,
            subject=data["subject"],
            order=order,
            order_number=order.order_number if order else "",
            # Money problems go up the queue straight away.
            priority=(
                TicketPriority.HIGH
                if kind in (TicketType.REFUND, TicketType.PAYMENT)
                else TicketPriority.MEDIUM
            ),
        )
        _message(ticket, user, data["message"])
        _event(ticket, user, "created").save()
    notify_admins(
        Permission.SUPPORT_MANAGE,
        type="support.new",
        title=f"New support ticket {ticket.number}",
        body=ticket.subject,
        link=_staff_link(ticket),
    )
    return _requester_view(ticket)


def list_mine(user: User, query: dict[str, Any], page: Page) -> dict[str, Any]:
    qs = SupportTicket.objects.filter(raised_by=user)
    if query.get("status") == "open":
        qs = qs.filter(status__in=OPEN)
    elif query.get("status") == "closed":
        qs = qs.filter(status__in=[T.RESOLVED, T.CLOSED])
    items, meta = paginate(qs.order_by("-last_activity_at", "-id"), page)
    return {
        "items": [_requester_view(t, with_messages=False) for t in items],
        "pagination": meta,
    }


def _find_mine(user: User, ticket_id: uuid.UUID, *, lock: bool = False) -> SupportTicket:
    qs = SupportTicket.objects.select_for_update() if lock else SupportTicket.objects
    ticket = qs.filter(pk=ticket_id, raised_by=user).first()
    if ticket is None:
        raise ApiError.not_found("Ticket not found")
    return ticket


def get_mine(user: User, ticket_id: uuid.UUID) -> dict[str, Any]:
    return _requester_view(_find_mine(user, ticket_id))


def reply_mine(user: User, ticket_id: uuid.UUID, body: str) -> dict[str, Any]:
    """The requester replies. A resolved ticket reopens; a closed one needs a new ticket."""
    with transaction.atomic():
        ticket = _find_mine(user, ticket_id, lock=True)
        if ticket.status == T.CLOSED:
            raise ApiError.bad_request("This ticket is closed. Please open a new one.")
        _message(ticket, user, body)
        target = T.IN_PROGRESS if ticket.assignee_id else T.OPEN
        if ticket.status != target:
            _event(ticket, user, "status", from_value=ticket.status, to_value=target).save()
            ticket.status = target
        ticket.last_activity_at = timezone.now()
        ticket.save(update_fields=["status", "last_activity_at", "updated_at"])
    payload = {
        "type": "support.reply",
        "title": f"New reply on {ticket.number}",
        "body": body[:140],
        "link": _staff_link(ticket),
    }
    if ticket.assignee_id:
        notify(ticket.assignee_id, **payload)
    else:
        notify_admins(Permission.SUPPORT_MANAGE, **payload)
    return _requester_view(ticket)


# ---------------------------------------------------------------------------
# Support staff
# ---------------------------------------------------------------------------
def dashboard() -> dict[str, Any]:
    counts = {
        row["status"]: row["n"]
        for row in SupportTicket.objects.values("status").annotate(n=Count("id")).order_by()
    }
    active = SupportTicket.objects.filter(status__in=OPEN)
    high_priority = active.filter(priority__in=[TicketPriority.HIGH, TicketPriority.URGENT]).count()
    unassigned = active.filter(assignee__isnull=True).count()
    by_role = {
        row["requester_role"]: row["n"]
        for row in active.values("requester_role").annotate(n=Count("id")).order_by()
    }
    return {
        "total": sum(counts.values()),
        "open": counts.get(T.OPEN, 0),
        "inProgress": counts.get(T.IN_PROGRESS, 0),
        # Waiting on the customer, restaurant or rider to reply.
        "pending": counts.get(T.WAITING_FOR_RESPONSE, 0),
        "resolved": counts.get(T.RESOLVED, 0),
        "closed": counts.get(T.CLOSED, 0),
        "highPriority": high_priority,
        "unassigned": unassigned,
        "openByRequester": {role: by_role.get(role, 0) for role in RequesterRole.values},
        "openRefundRequests": active.filter(type=TicketType.REFUND).count(),
    }


def staff_list() -> dict[str, Any]:
    """People a ticket can be assigned to: active admins with the support permission."""
    users = User.objects.filter(role__in=_support_roles(), status=UserStatus.ACTIVE).order_by(
        "name", "id"
    )
    return {"items": [{"id": str(u.pk), "name": u.name, "role": u.role} for u in users]}


def _support_roles() -> list[str]:
    return [r.value for r in ADMIN_ROLES if has_permission(r, Permission.SUPPORT_MANAGE)]


def staff_tickets(staff: User, query: dict[str, Any], page: Page) -> dict[str, Any]:
    qs: QuerySet[SupportTicket] = SupportTicket.objects.select_related("assignee")
    status = query.get("status")
    if status == "active":
        qs = qs.filter(status__in=OPEN)
    elif status:
        qs = qs.filter(status=status)
    for field in ("priority", "requester_role", "type"):
        if query.get(field):
            qs = qs.filter(**{field: query[field]})
    if query.get("assignee") == "me":
        qs = qs.filter(assignee=staff)
    elif query.get("assignee") == "unassigned":
        qs = qs.filter(assignee__isnull=True)
    search = (query.get("search") or "").strip()
    if search:
        qs = qs.filter(
            Q(number__icontains=search)
            | Q(subject__icontains=search)
            | Q(order_number__icontains=search)
            | Q(requester_name__icontains=search)
        )
    qs = qs.annotate(message_count=Count("messages")).order_by("-last_activity_at", "-id")
    items, meta = paginate(qs, page)
    return {
        "items": [_staff_summary(t, t.message_count) for t in items],
        "pagination": meta,
    }


def _find(ticket_id: uuid.UUID, *, lock: bool = False) -> SupportTicket:
    qs = SupportTicket.objects.select_for_update() if lock else SupportTicket.objects
    ticket = qs.filter(pk=ticket_id).first()
    if ticket is None:
        raise ApiError.not_found("Ticket not found")
    return ticket


def get(ticket_id: uuid.UUID) -> dict[str, Any]:
    return _staff_view(_find(ticket_id).pk)


def update(staff: User, ticket_id: uuid.UUID, data: dict[str, Any]) -> dict[str, Any]:
    """Status, priority and assignee changes, each recorded in the ticket history."""
    status = data.get("status")
    priority = data.get("priority")
    assigned_to: User | None = None
    with transaction.atomic():
        ticket = _find(ticket_id, lock=True)
        events: list[SupportTicketEvent] = []
        now = timezone.now()
        if status and status != ticket.status:
            events.append(
                _event(
                    ticket,
                    staff,
                    "status",
                    from_value=ticket.status,
                    to_value=status,
                    note=data.get("note") or "",
                )
            )
            ticket.status = status
            if status == T.RESOLVED:
                ticket.resolved_at = now
            if status == T.CLOSED:
                ticket.closed_at = now
        if priority and priority != ticket.priority:
            events.append(
                _event(ticket, staff, "priority", from_value=ticket.priority, to_value=priority)
            )
            ticket.priority = priority
        if "assignee_id" in data:
            wanted = data["assignee_id"]
            if wanted != ticket.assignee_id:
                assignee = None
                if wanted:
                    assignee = User.objects.filter(
                        pk=wanted, status=UserStatus.ACTIVE, role__in=list(ADMIN_ROLES)
                    ).first()
                    if assignee is None or not has_permission(
                        assignee.role, Permission.SUPPORT_MANAGE
                    ):
                        raise ApiError.bad_request("Assign the ticket to an active support admin")
                events.append(
                    _event(
                        ticket,
                        staff,
                        "assigned",
                        to_value=assignee.name if assignee else "Unassigned",
                    )
                )
                ticket.assignee = assignee
                if assignee is not None and assignee.pk != staff.pk:
                    assigned_to = assignee
        if not events:
            return _staff_view(ticket.pk)
        _save_events(events)
        ticket.last_activity_at = now
        ticket.save()
    if assigned_to is not None:
        notify(
            assigned_to.pk,
            type="support.assigned",
            title=f"Ticket {ticket.number} assigned to you",
            body=ticket.subject,
            link=_staff_link(ticket),
        )
    if status in (T.RESOLVED, T.WAITING_FOR_RESPONSE, T.CLOSED):
        notify(
            ticket.raised_by_id,
            type="support.status",
            title=f"Ticket {ticket.number}: {STATUS_LABEL[T(status)]}",
            body=ticket.subject,
            link=_requester_link(ticket),
        )
    return _staff_view(ticket.pk)


def add_message(
    staff: User, ticket_id: uuid.UUID, body: str, internal: bool = False
) -> dict[str, Any]:
    """
    A staff reply or internal note. A reply to the requester moves the ticket to "waiting for
    response" (unless it is already resolved or closed) and notifies them; notes notify nobody.
    """
    with transaction.atomic():
        ticket = _find(ticket_id, lock=True)
        if ticket.status == T.CLOSED and not internal:
            raise ApiError.bad_request("Reopen the ticket before replying")
        _message(ticket, staff, body, internal)
        if not internal and ticket.status in OPEN and ticket.status != T.WAITING_FOR_RESPONSE:
            _event(
                ticket, staff, "status", from_value=ticket.status, to_value=T.WAITING_FOR_RESPONSE
            ).save()
            ticket.status = T.WAITING_FOR_RESPONSE
        if ticket.assignee_id is None:
            ticket.assignee = staff  # whoever answers first owns it
        ticket.last_activity_at = timezone.now()
        ticket.save()
    if not internal:
        notify(
            ticket.raised_by_id,
            type="support.reply",
            title=f"BiteBox Support replied on {ticket.number}",
            body=body[:140],
            link=_requester_link(ticket),
        )
    return _staff_view(ticket.pk)


def escalate_to_finance(staff: User, ticket_id: uuid.UUID, note: str) -> dict[str, Any]:
    """Sends a refund or payment problem to the finance team (they get a notification)."""
    with transaction.atomic():
        ticket = _find(ticket_id, lock=True)
        _event(ticket, staff, "escalated", to_value="finance", note=note).save()
        _message(ticket, staff, f"Escalated to finance: {note}", internal=True)
        ticket.last_activity_at = timezone.now()
        ticket.save(update_fields=["last_activity_at", "updated_at"])
    prefix = f"Order {ticket.order_number}: " if ticket.order_number else ""
    notify_admins(
        Permission.REFUNDS_MANAGE,
        type="support.escalated",
        title=f"Refund/payment issue from support ({ticket.number})",
        body=f"{prefix}{note}"[:200],
        link="/admin/finance/refunds",
    )
    return _staff_view(ticket.pk)
