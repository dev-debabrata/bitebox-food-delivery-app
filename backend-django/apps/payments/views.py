"""
Payment endpoints (Node: routes/payment.routes.js and the admin payments router):
/payments/* for customers, the Razorpay webhook, and /admin/payments for finance.
"""

import re
from typing import Any

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from apps.audit.services import audited
from apps.orders.models import PaymentMethod, PaymentStatus
from apps.orders.notifications import rupees
from apps.rbac.roles import Permission, Role
from common.api import ApiError, ok
from common.pagination import Page
from common.permissions import PUBLIC, permission_required, role_required
from common.schema import envelope, errors
from common.validation import PageQuery, parse_id, validated

from . import services
from .models import Provider

PAYMENT = envelope("PaymentResult")
PAYMENT_DETAIL = envelope("AdminPaymentResult")
PAYMENT_LIST = envelope("PaymentList")
KEY = re.compile(r"^[A-Za-z0-9_-]{8,100}$")
CUSTOMER = [role_required(Role.CUSTOMER)]


def _choice(choices: list[str], message: str, **kwargs: Any) -> serializers.ChoiceField:
    keys = ("invalid_choice", "required", "null", "blank")
    return serializers.ChoiceField(
        choices=choices, error_messages=dict.fromkeys(keys, message), **kwargs
    )


class MethodsView(APIView):
    permission_classes = PUBLIC
    authentication_classes: list[Any] = []

    @extend_schema(tags=["Payments"], responses={200: envelope("PaymentMethods")})
    def get(self, request: Request) -> Response:
        return ok({"methods": services.available_methods()})


class MineView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Payments"],
        operation_id="payments_mine",
        parameters=[OpenApiParameter("page", int), OpenApiParameter("limit", int)],
        responses={200: PAYMENT_LIST, **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(PageQuery, request.query_params)
        return ok(services.list_mine(current_user(request), Page.from_query(query)))


class StartView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Payments"],
        request=None,
        responses={200: envelope("CheckoutSession"), **errors(400, 401, 403, 404, 409, 503)},
    )
    def post(self, request: Request, order_id: str) -> Response:
        checkout = services.start_payment(current_user(request), parse_id(order_id, "orderId"))
        return ok({"checkout": checkout})


class ConfirmInput(serializers.Serializer):
    provider_payment_id = serializers.CharField(
        min_length=4,
        max_length=100,
        error_messages=dict.fromkeys(
            ("required", "blank", "null", "min_length", "max_length", "invalid"),
            "Missing payment id",
        ),
    )
    signature = serializers.CharField(
        min_length=16,
        max_length=200,
        error_messages=dict.fromkeys(
            ("required", "blank", "null", "min_length", "max_length", "invalid"),
            "Missing signature",
        ),
    )


class ConfirmView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Payments"],
        request=ConfirmInput,
        responses={200: PAYMENT, **errors(400, 401, 403, 404, 422, 503)},
    )
    def post(self, request: Request, order_id: str) -> Response:
        order = parse_id(order_id, "orderId")
        data = validated(ConfirmInput, request.data)
        payment = services.confirm_payment(
            current_user(request), order, data["provider_payment_id"], data["signature"]
        )
        return ok({"payment": payment})


class AbandonView(APIView):
    """Closed the payment page at checkout: cancel the unpaid order and refill the cart."""

    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Payments"],
        request=None,
        responses={200: envelope("AbandonResult"), **errors(401, 403, 404, 409)},
    )
    def post(self, request: Request, order_id: str) -> Response:
        order = parse_id(order_id, "orderId")
        return ok(services.abandon_unpaid(current_user(request), order))


class MockInput(serializers.Serializer):
    outcome = _choice(["success", "failure"], "Outcome must be success or failure")


class MockView(APIView):
    """Development only (refused when the simulated provider is off)."""

    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Payments"],
        request=MockInput,
        responses={200: PAYMENT, **errors(400, 401, 403, 404, 409, 422)},
    )
    def post(self, request: Request, order_id: str) -> Response:
        order = parse_id(order_id, "orderId")
        data = validated(MockInput, request.data)
        payment = services.complete_mock_payment(current_user(request), order, data["outcome"])
        return ok({"payment": payment})


class RazorpayWebhookView(APIView):
    """Signed over the exact raw body, so the body is read before any parsing."""

    permission_classes = PUBLIC

    authentication_classes: list[Any] = []

    @extend_schema(
        tags=["Payments"],
        request=None,
        parameters=[
            OpenApiParameter("X-Razorpay-Signature", str, OpenApiParameter.HEADER),
            OpenApiParameter("X-Razorpay-Event-Id", str, OpenApiParameter.HEADER),
        ],
        responses={200: envelope("WebhookResult"), **errors(400)},
    )
    def post(self, request: Request) -> Response:
        raw = request._request.body
        if len(raw) > 100 * 1024:
            raise ApiError(413, "Webhook body too large")
        result = services.handle_razorpay_webhook(
            raw,
            request.headers.get("X-Razorpay-Signature"),
            request.headers.get("X-Razorpay-Event-Id"),
        )
        return ok(result)


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
class AdminPaymentQuery(PageQuery):
    status = _choice(PaymentStatus.values, "Invalid value", required=False)
    method = _choice(PaymentMethod.values, "Invalid value", required=False)
    provider = _choice(Provider.values, "Invalid value", required=False)
    # Where the order stands, so finance can find cancelled orders that still hold money.
    order_state = _choice(list(services.ORDER_STATES), "Invalid value", required=False)
    to = serializers.DateTimeField(required=False)

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.fields["from"] = serializers.DateTimeField(required=False)


class AdminPaymentsView(APIView):
    permission_classes = [permission_required(Permission.FINANCE_VIEW)]

    @extend_schema(
        tags=["Admin: payments"],
        parameters=[AdminPaymentQuery],
        responses={200: PAYMENT_LIST, **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(AdminPaymentQuery, request.query_params)
        return ok(services.admin_list(query, Page.from_query(query)))


class AdminPaymentView(APIView):
    permission_classes = [permission_required(Permission.FINANCE_VIEW)]

    @extend_schema(
        tags=["Admin: payments"],
        operation_id="admin_payments_get",
        responses={200: PAYMENT_DETAIL, **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        return ok(services.admin_get(parse_id(id)))


class AdminRetryRefundView(APIView):
    permission_classes = [permission_required(Permission.REFUNDS_MANAGE)]

    @extend_schema(
        tags=["Admin: payments"],
        operation_id="admin_payments_refund_retry",
        request=None,
        responses={200: PAYMENT, **errors(401, 403, 404, 409, 422)},
    )
    @audited("payment.refund", "payment", lambda req: "Retried a failed refund")
    def post(self, request: Request, id: str) -> Response:
        payment = services.admin_retry_refund(parse_id(id))
        return ok({"payment": payment}, message="Refund issued")


class RefundInput(serializers.Serializer):
    amount_paise = serializers.IntegerField(
        min_value=1,
        error_messages=dict.fromkeys(
            ("required", "null", "invalid", "min_value"), "Enter an amount to refund"
        ),
    )
    reason = serializers.CharField(
        max_length=300,
        trim_whitespace=True,
        error_messages={
            **dict.fromkeys(("required", "blank", "null"), "Give a reason"),
            "max_length": "Keep the reason under 300 characters",
        },
    )


def _refund_summary(req: Request) -> str:
    amount = rupees(int(req.data.get("amount_paise") or 0))
    return f"Refunded {amount}: {str(req.data.get('reason') or '').strip()}"[:300]


class AdminRefundView(APIView):
    """A full or partial refund. An Idempotency-Key header makes a retried request safe."""

    permission_classes = [permission_required(Permission.REFUNDS_MANAGE)]

    @extend_schema(
        tags=["Admin: payments"],
        operation_id="admin_payments_refund_create",
        request=RefundInput,
        parameters=[OpenApiParameter("Idempotency-Key", str, OpenApiParameter.HEADER)],
        responses={200: PAYMENT_DETAIL, **errors(401, 403, 404, 409, 422)},
    )
    @audited("payment.partial_refund", "payment", _refund_summary)
    def post(self, request: Request, id: str) -> Response:
        payment_id = parse_id(id)
        data = validated(RefundInput, request.data)
        key = request.headers.get("Idempotency-Key")
        result = services.admin_refund(
            current_user(request),
            payment_id,
            data["amount_paise"],
            data["reason"],
            key if key and KEY.match(key) else None,
        )
        return ok(result, message="Refund started")


class AdminManualRefundDoneView(APIView):
    permission_classes = [permission_required(Permission.REFUNDS_MANAGE)]

    @extend_schema(
        tags=["Admin: payments"],
        request=None,
        responses={200: PAYMENT_DETAIL, **errors(401, 403, 404, 409, 422)},
    )
    @audited("payment.refund_paid", "refund", lambda req: "Marked a cash refund as paid")
    def post(self, request: Request, id: str) -> Response:
        result = services.admin_complete_manual_refund(parse_id(id))
        return ok(result, message="Refund marked as paid")
