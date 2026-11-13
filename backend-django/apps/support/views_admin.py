"""/admin/support: the support queue, ticket handling and the support dashboard (Node:
support.routes.js adminSupportRouter)."""

from drf_spectacular.utils import extend_schema
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from apps.audit.services import audited
from apps.rbac.roles import Permission
from common.api import ok
from common.pagination import Page
from common.permissions import permission_required
from common.schema import envelope, errors
from common.validation import parse_id, validated

from . import services
from .serializers import EscalateInput, StaffMessageInput, StaffTicketQuery, UpdateTicketInput

SUPPORT = [permission_required(Permission.SUPPORT_MANAGE)]
TAGS = ["Admin: support"]
TICKET = envelope("SupportTicketResult")


def _update_note(request: Request) -> str:
    """e.g. "status → resolved, assignee → none" (Node: the ticket.update audit description)."""
    body = request.data
    assignee = body.get("assignee_id", ...)
    changes = {
        "status": body.get("status"),
        "priority": body.get("priority"),
        "assignee": None if assignee is ... else (assignee or "none"),
    }
    text = ", ".join(f"{k} → {v}" for k, v in changes.items() if v is not None)
    return text or "Updated ticket"


class SupportDashboardView(APIView):
    permission_classes = SUPPORT

    @extend_schema(tags=TAGS, responses={200: envelope("SupportDashboard"), **errors(401, 403)})
    def get(self, request: Request) -> Response:
        return ok(services.dashboard())


class SupportStaffView(APIView):
    permission_classes = SUPPORT

    @extend_schema(tags=TAGS, responses={200: envelope("SupportStaff"), **errors(401, 403)})
    def get(self, request: Request) -> Response:
        return ok(services.staff_list())


class SupportTicketsView(APIView):
    permission_classes = SUPPORT

    @extend_schema(
        tags=TAGS,
        operation_id="admin_support_tickets_list",
        parameters=[StaffTicketQuery],
        responses={200: envelope("SupportTicketList"), **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(StaffTicketQuery, request.query_params)
        return ok(services.staff_tickets(current_user(request), query, Page.from_query(query)))


class SupportTicketView(APIView):
    permission_classes = SUPPORT

    @extend_schema(
        tags=TAGS,
        operation_id="admin_support_tickets_get",
        responses={200: TICKET, **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        return ok({"ticket": services.get(parse_id(id))})

    @extend_schema(
        tags=TAGS,
        operation_id="admin_support_tickets_update",
        request=UpdateTicketInput,
        responses={200: TICKET, **errors(400, 401, 403, 404, 422)},
    )
    @audited("ticket.update", "ticket", _update_note)
    def patch(self, request: Request, id: str) -> Response:
        ticket_id = parse_id(id)
        data = validated(UpdateTicketInput, request.data)
        ticket = services.update(current_user(request), ticket_id, data)
        return ok({"ticket": ticket}, message="Ticket updated")


class SupportTicketMessagesView(APIView):
    permission_classes = SUPPORT

    @extend_schema(
        tags=TAGS,
        operation_id="admin_support_tickets_message",
        request=StaffMessageInput,
        responses={200: TICKET, **errors(400, 401, 403, 404, 422)},
    )
    def post(self, request: Request, id: str) -> Response:
        ticket_id = parse_id(id)
        data = validated(StaffMessageInput, request.data)
        internal = bool(data.get("internal", False))
        ticket = services.add_message(current_user(request), ticket_id, data["body"], internal)
        return ok({"ticket": ticket}, message="Note added" if internal else "Reply sent")


class SupportTicketEscalateView(APIView):
    permission_classes = SUPPORT

    @extend_schema(
        tags=TAGS,
        operation_id="admin_support_tickets_escalate",
        request=EscalateInput,
        responses={200: TICKET, **errors(401, 403, 404, 422)},
    )
    @audited(
        "ticket.escalate",
        "ticket",
        lambda request: f"Escalated to finance: {str(request.data.get('note', '')).strip()}",
    )
    def post(self, request: Request, id: str) -> Response:
        ticket_id = parse_id(id)
        data = validated(EscalateInput, request.data)
        ticket = services.escalate_to_finance(current_user(request), ticket_id, data["note"])
        return ok({"ticket": ticket}, message="Sent to the finance team")
