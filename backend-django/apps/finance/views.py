"""Finance endpoints: earnings, admin reports and finance (payouts, commission, ledger,
refund queue), invoices and statements, and partners' settlement history."""

from typing import Any

from django.http import HttpResponse
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from apps.audit.services import audited
from apps.orders.models import Order
from apps.orders.notifications import rupees
from apps.rbac.roles import Permission, Role
from common.api import ApiError, ok
from common.pagination import Page
from common.permissions import permission_required, role_required
from common.schema import envelope, errors
from common.validation import PageQuery, parse_id, validated

from . import invoices, ledger, reports, services
from .models import Payout, PayoutStatus, PayoutType


class DaysQuery(serializers.Serializer):
    days = serializers.IntegerField(
        required=False,
        min_value=1,
        max_value=365,
        error_messages=dict.fromkeys(("invalid", "min_value", "max_value"), "Invalid value"),
    )


class RestaurantEarningsView(APIView):
    permission_classes = [role_required(Role.RESTAURANT)]

    @extend_schema(
        tags=["My restaurant"],
        parameters=[DaysQuery],
        responses={200: envelope("Earnings"), **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request) -> Response:
        days = validated(DaysQuery, request.query_params).get("days", 30)
        return ok(reports.restaurant_earnings(current_user(request), days))


class AdminReportsView(APIView):
    permission_classes = [permission_required(Permission.FINANCE_VIEW)]

    @extend_schema(
        tags=["Admin: reports"],
        parameters=[DaysQuery],
        responses={200: envelope("AdminReport"), **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        days = validated(DaysQuery, request.query_params).get("days", 30)
        return ok(reports.admin_report(days))


# ---------------------------------------------------------------------------
# Phase 15: admin finance (Node: routes/admin-finance.routes.js) and the new finance features
# ---------------------------------------------------------------------------
FINANCE = [permission_required(Permission.FINANCE_VIEW)]
PAYOUTS = [permission_required(Permission.PAYOUTS_MANAGE)]
PDF = OpenApiResponse(description="PDF document")
RULES = envelope("CommissionRules")
PAYOUT = envelope("PayoutResult")
PAYOUT_LIST = envelope("PayoutList")


def pdf_response(result: tuple[str, bytes]) -> HttpResponse:
    name, body = result
    response = HttpResponse(body, content_type="application/pdf")
    response["Content-Disposition"] = f'attachment; filename="{name}"'
    response["Cache-Control"] = "private, no-store"
    return response


def _days(request: Request) -> int:
    return int(validated(DaysQuery, request.query_params).get("days", 30))


class FinanceDashboardView(APIView):
    permission_classes = FINANCE

    @extend_schema(
        tags=["Admin: finance"],
        parameters=[DaysQuery],
        responses={200: envelope("FinanceDashboard")},
    )
    def get(self, request: Request) -> Response:
        return ok(services.dashboard(_days(request)))


class TransactionView(APIView):
    permission_classes = FINANCE

    @extend_schema(
        tags=["Admin: finance"], responses={200: envelope("Transaction"), **errors(404, 422)}
    )
    def get(self, request: Request, id: str) -> Response:
        return ok(services.transaction_detail(parse_id(id)))


class CommissionReportView(APIView):
    permission_classes = FINANCE

    @extend_schema(
        tags=["Admin: finance"],
        parameters=[DaysQuery],
        responses={200: envelope("CommissionReport")},
    )
    def get(self, request: Request) -> Response:
        return ok(services.commission_report(_days(request)))


class RefundQuery(PageQuery):
    state = serializers.ChoiceField(choices=["needed", "refunded"], required=False)


class RefundQueueView(APIView):
    permission_classes = FINANCE

    @extend_schema(
        tags=["Admin: finance"], parameters=[RefundQuery], responses={200: envelope("RefundQueue")}
    )
    def get(self, request: Request) -> Response:
        query = validated(RefundQuery, request.query_params)
        return ok(services.refunds(query.get("state"), Page.from_query(query)))


class CommissionRuleInput(serializers.Serializer):
    restaurant_id = serializers.UUIDField(required=False, allow_null=True)
    basis_points = serializers.IntegerField(
        min_value=0,
        max_value=5000,
        error_messages=dict.fromkeys(
            ("required", "invalid", "min_value", "max_value"),
            "Commission must be between 0 and 50 percent",
        ),
    )
    note = serializers.CharField(required=False, allow_blank=True, max_length=300)


class CommissionRulesView(APIView):
    """The global rate and per-restaurant overrides (reading: finance:view; changing: payouts)."""

    def get_permissions(self) -> list[Any]:
        return [(PAYOUTS if self.request.method == "PUT" else FINANCE)[0]()]

    @extend_schema(tags=["Admin: finance"], responses={200: RULES})
    def get(self, request: Request) -> Response:
        return ok(services.commission_rules())

    @extend_schema(
        tags=["Admin: finance"],
        request=CommissionRuleInput,
        responses={200: RULES, **errors(403, 404, 422)},
    )
    @audited(
        "commission.set",
        "commission",
        lambda req: (
            f"Set commission to {int(req.data.get('basis_points', 0)) / 100:g}%"
            + (" for a restaurant" if req.data.get("restaurant_id") else " (global)")
        ),
    )
    def put(self, request: Request) -> Response:
        data = validated(CommissionRuleInput, request.data)
        result = services.set_commission(
            current_user(request),
            data.get("restaurant_id"),
            data["basis_points"],
            data.get("note") or "",
        )
        return ok(result, message="Commission saved")


class CommissionOverrideView(APIView):
    permission_classes = PAYOUTS

    @extend_schema(tags=["Admin: finance"], responses={200: RULES, **errors(404, 422)})
    @audited("commission.clear", "restaurant", lambda req: "Removed a restaurant's own commission")
    def delete(self, request: Request, id: str) -> Response:
        return ok(
            services.clear_commission(parse_id(id)), message="The global commission applies again"
        )


class PayoutTypeQuery(serializers.Serializer):
    type = serializers.ChoiceField(
        choices=PayoutType.values,
        error_messages=dict.fromkeys(
            ("required", "invalid_choice"), "Type must be restaurant or rider"
        ),
    )


class PayoutListQuery(PageQuery):
    type = serializers.ChoiceField(choices=PayoutType.values, required=False)
    status = serializers.ChoiceField(choices=PayoutStatus.values, required=False)


class CreatePayoutInput(serializers.Serializer):
    type = serializers.ChoiceField(
        choices=PayoutType.values,
        error_messages=dict.fromkeys(
            ("required", "invalid_choice"), "Type must be restaurant or rider"
        ),
    )
    payee_id = serializers.UUIDField(
        error_messages=dict.fromkeys(("required", "invalid", "null"), "Choose who to pay")
    )
    note = serializers.CharField(required=False, allow_blank=True, max_length=500)


class PayInput(serializers.Serializer):
    reference = serializers.CharField(
        min_length=3,
        max_length=120,
        error_messages=dict.fromkeys(
            ("required", "blank", "min_length", "max_length"),
            "Enter the bank or UPI transfer reference",
        ),
    )


class PayoutCancelInput(serializers.Serializer):
    note = serializers.CharField(required=False, allow_blank=True, max_length=500)


class PayoutsDueView(APIView):
    permission_classes = PAYOUTS

    @extend_schema(
        tags=["Admin: finance"],
        parameters=[PayoutTypeQuery],
        responses={200: envelope("PayoutsDue")},
    )
    def get(self, request: Request) -> Response:
        return ok(services.payouts_due(validated(PayoutTypeQuery, request.query_params)["type"]))


class PayoutsView(APIView):
    permission_classes = PAYOUTS

    @extend_schema(
        tags=["Admin: finance"],
        parameters=[PayoutListQuery],
        responses={200: PAYOUT_LIST},
    )
    def get(self, request: Request) -> Response:
        query = validated(PayoutListQuery, request.query_params)
        return ok(services.list_payouts(query, Page.from_query(query)))

    @extend_schema(
        tags=["Admin: finance"],
        request=CreatePayoutInput,
        responses={201: PAYOUT, **errors(400, 403, 404, 422)},
    )
    @audited(
        "payout.create",
        "payout",
        lambda req: (
            f"Created a {req.data.get('type')} payout of "
            f"{getattr(req, 'payout_amount', '')} for {getattr(req, 'payout_name', 'a payee')}"
        ),
    )
    def post(self, request: Request) -> Response:
        data = validated(CreatePayoutInput, request.data)
        payout = services.create_payout(
            current_user(request), data["type"], data["payee_id"], data.get("note") or ""
        )
        request.audit_resource_id = payout["id"]  # type: ignore[attr-defined]
        request.payout_amount = rupees(payout["amount_paise"])  # type: ignore[attr-defined]
        request.payout_name = payout["payee_name"]  # type: ignore[attr-defined]
        return ok({"payout": payout}, message="Payout created", status=201)


class PayoutPaidView(APIView):
    permission_classes = PAYOUTS

    @extend_schema(
        tags=["Admin: finance"],
        request=PayInput,
        responses={200: PAYOUT, **errors(409, 422)},
    )
    @audited(
        "payout.paid",
        "payout",
        lambda req: f"Marked payout as paid (ref {req.data.get('reference', '')})",
    )
    def post(self, request: Request, id: str) -> Response:
        payout_id = parse_id(id)
        data = validated(PayInput, request.data)
        payout = services.mark_payout_paid(
            current_user(request), payout_id, data["reference"].strip()
        )
        return ok({"payout": payout}, message="Payout marked as paid")


class PayoutCancelView(APIView):
    permission_classes = PAYOUTS

    @extend_schema(
        tags=["Admin: finance"],
        request=PayoutCancelInput,
        responses={200: PAYOUT, **errors(409, 422)},
    )
    @audited(
        "payout.cancel",
        "payout",
        lambda req: ": ".join(
            p for p in ("Cancelled payout", str(req.data.get("note") or "").strip()) if p
        ),
    )
    def post(self, request: Request, id: str) -> Response:
        payout_id = parse_id(id)
        data = validated(PayoutCancelInput, request.data)
        return ok(
            {"payout": services.cancel_payout(payout_id, data.get("note"))},
            message="Payout cancelled",
        )


class AdminStatementView(APIView):
    permission_classes = FINANCE

    @extend_schema(tags=["Admin: finance"], responses={200: PDF, **errors(404, 422)})
    def get(self, request: Request, id: str) -> HttpResponse:
        payout = Payout.objects.filter(pk=parse_id(id)).first()
        if payout is None:
            raise ApiError.not_found("Payout not found")
        return pdf_response(invoices.payout_statement(payout))


class LedgerView(APIView):
    permission_classes = FINANCE

    @extend_schema(
        tags=["Admin: finance"],
        parameters=[DaysQuery, OpenApiParameter("page", int), OpenApiParameter("limit", int)],
        responses={200: envelope("Ledger")},
    )
    def get(self, request: Request) -> Response:
        page = validated(PageQuery, request.query_params)
        return ok(ledger.summary(_days(request), Page.from_query(page)))


class SettlementsCsvQuery(serializers.Serializer):
    to = serializers.DateTimeField(required=False)

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.fields["from"] = serializers.DateTimeField(required=False)


class SettlementsCsvView(APIView):
    permission_classes = FINANCE

    @extend_schema(
        tags=["Admin: finance"],
        parameters=[SettlementsCsvQuery],
        responses={200: OpenApiResponse(description="CSV, one row per delivered order")},
    )
    def get(self, request: Request) -> HttpResponse:
        query = validated(SettlementsCsvQuery, request.query_params)
        response = HttpResponse(
            services.settlements_csv(query.get("from"), query.get("to")),
            content_type="text/csv; charset=utf-8",
        )
        response["Content-Disposition"] = 'attachment; filename="BiteBox-settlements.csv"'
        return response


class AdminOrderInvoiceView(APIView):
    permission_classes = FINANCE

    @extend_schema(tags=["Admin: finance"], responses={200: PDF, **errors(404, 409, 422)})
    def get(self, request: Request, id: str) -> HttpResponse:
        order = Order.objects.filter(pk=parse_id(id)).prefetch_related("items").first()
        if order is None:
            raise ApiError.not_found("Order not found")
        return pdf_response(invoices.order_invoice(order))


# --- customers and partners -------------------------------------------------------------------
class OrderInvoiceView(APIView):
    permission_classes = [role_required(Role.CUSTOMER)]

    @extend_schema(tags=["Orders"], responses={200: PDF, **errors(404, 409, 422)})
    def get(self, request: Request, id: str) -> HttpResponse:
        order = (
            Order.objects.filter(pk=parse_id(id), customer=current_user(request))
            .prefetch_related("items")
            .first()
        )
        if order is None:
            raise ApiError.not_found("Order not found")
        return pdf_response(invoices.order_invoice(order))


def _partner_scope(request: Request) -> tuple[str, dict[str, Any], dict[str, Any]]:
    """(payout type, payout filter, settlement filter) for the signed-in partner."""
    user = current_user(request)
    if user.role == Role.RESTAURANT:
        restaurant = services.restaurant_of(user)
        return PayoutType.RESTAURANT, {"restaurant": restaurant}, {"order__restaurant": restaurant}
    return (
        PayoutType.RIDER,
        {"type": PayoutType.RIDER, "payee": user},
        {"order__delivery_partner": user},
    )


PARTNERS = [role_required(Role.RESTAURANT, Role.DELIVERY)]


class MyPayoutsView(APIView):
    permission_classes = PARTNERS

    @extend_schema(tags=["Partner finance"], parameters=[PageQuery], responses={200: PAYOUT_LIST})
    def get(self, request: Request) -> Response:
        query = validated(PageQuery, request.query_params)
        _, scope, _ = _partner_scope(request)
        return ok(services.list_payouts({}, Page.from_query(query, default_limit=10), **scope))


class MySettlementsView(APIView):
    permission_classes = PARTNERS

    @extend_schema(
        tags=["Partner finance"],
        parameters=[PageQuery],
        responses={200: envelope("SettlementHistory")},
    )
    def get(self, request: Request) -> Response:
        query = validated(PageQuery, request.query_params)
        type, _, scope = _partner_scope(request)
        return ok(
            services.settlement_history(Page.from_query(query, default_limit=10), type, **scope)
        )


class MyStatementView(APIView):
    permission_classes = PARTNERS

    @extend_schema(tags=["Partner finance"], responses={200: PDF, **errors(404, 422)})
    def get(self, request: Request, id: str) -> HttpResponse:
        _, scope, _ = _partner_scope(request)
        payout = Payout.objects.filter(pk=parse_id(id), **scope).first()
        if payout is None:
            raise ApiError.not_found("Payout not found")
        return pdf_response(invoices.payout_statement(payout))
