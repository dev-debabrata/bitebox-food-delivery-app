"""
Order endpoints for customers (/orders), restaurant partners (/my/restaurant/orders) and admins
(/admin/orders). Same paths, messages and validation as the Node API.
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
from apps.payments.services import start_payment
from apps.rbac.roles import Permission, Role
from common.api import ApiError, ok
from common.fields import UUIDRef
from common.pagination import Page
from common.permissions import permission_required, role_required
from common.schema import envelope, errors
from common.throttling import rate_limit
from common.validation import PageQuery, parse_id, validated

from . import services
from .models import OrderStatus, PaymentMethod
from .presenters import order_json

S = OrderStatus
ORDER = envelope("OrderResult")
ORDER_LIST = envelope("OrderList")
PLACED = envelope("OrderPlaced")
IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9_-]{8,100}$")

STATUS_MESSAGE = {
    S.CONFIRMED: "Order accepted",
    S.REJECTED: "Order rejected",
    S.PREPARING: "Marked as preparing",
    S.READY_FOR_PICKUP: "Marked ready for pickup",
    S.PICKED_UP: "Marked as picked up",
    S.ON_THE_WAY: "On the way",
    S.ARRIVED_AT_RESTAURANT: "Marked as arrived. Collect the order when it is ready.",
    S.DELIVERED: "Delivered. Nice work!",
}


def reason_field(required: bool = False) -> serializers.CharField:
    too_long = "Keep the reason under 300 characters"
    missing = "Give a reason"
    return serializers.CharField(
        required=required,
        allow_blank=not required,
        allow_null=not required,
        max_length=300,
        trim_whitespace=True,
        error_messages={
            "max_length": too_long,
            "invalid": too_long,
            "required": missing,
            "blank": missing,
            "null": missing,
        },
    )


def _choice(choices: list[str], message: str, **kwargs: Any) -> serializers.ChoiceField:
    keys = ("invalid_choice", "required", "null", "blank")
    return serializers.ChoiceField(
        choices=choices, error_messages=dict.fromkeys(keys, message), **kwargs
    )


# ---------------------------------------------------------------------------
# Customer
# ---------------------------------------------------------------------------
class PlaceOrderInput(serializers.Serializer):
    address_id = UUIDRef(
        message="Choose a delivery address",
        error_messages={
            "required": "Choose a delivery address",
            "null": "Choose a delivery address",
        },
    )
    payment_method = _choice(PaymentMethod.values, "Choose a payment method")
    note = serializers.CharField(required=False, allow_blank=True, max_length=300)
    expected_total_paise = serializers.IntegerField(required=False, min_value=0)


class CancelInput(serializers.Serializer):
    reason = reason_field()


def _idempotency_key(request: Request) -> str | None:
    key = request.headers.get("Idempotency-Key")
    if key is None:
        return None
    if not IDEMPOTENCY_KEY.match(key):
        raise ApiError(
            422,
            "Validation failed",
            code="VALIDATION_ERROR",
            details=[
                {
                    "field": "idempotency-key",
                    "message": "Idempotency-Key must be 8-100 letters, digits, - or _",
                }
            ],
        )
    return key


class OrdersView(APIView):
    permission_classes = [role_required(Role.CUSTOMER)]

    def get_throttles(self) -> list[Any]:
        if self.request.method == "POST":
            return [
                rate_limit("ORDER_RATE_LIMIT", "Too many order attempts. Please wait a moment.")()
            ]
        return []

    @extend_schema(
        tags=["Orders"],
        operation_id="orders_list",
        parameters=[OpenApiParameter("page", int), OpenApiParameter("limit", int)],
        responses={200: ORDER_LIST, **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(PageQuery, request.query_params)
        return ok(
            services.list_mine(current_user(request), Page.from_query(query, default_limit=10))
        )

    @extend_schema(
        tags=["Orders"],
        operation_id="orders_place",
        parameters=[OpenApiParameter("Idempotency-Key", str, OpenApiParameter.HEADER)],
        request=PlaceOrderInput,
        responses={201: PLACED, 200: PLACED, **errors(400, 401, 403, 404, 409, 422, 429)},
    )
    def post(self, request: Request) -> Response:
        key = _idempotency_key(request)
        data = validated(PlaceOrderInput, request.data)
        user = current_user(request)
        order, created = services.place_order(user, data, key)
        # Online: hand back the gateway checkout right away (the order page can retry "Pay now").
        checkout = None
        if order.payment_method == PaymentMethod.ONLINE and order.payment_status != "paid":
            try:
                checkout = start_payment(user, order.pk)
            except ApiError:
                checkout = None
        return ok(
            {"order": order_json(order), "checkout": checkout},
            message="Order placed" if created else "Order already placed",
            status=201 if created else 200,
        )


class OrderView(APIView):
    permission_classes = [role_required(Role.CUSTOMER)]

    @extend_schema(tags=["Orders"], responses={200: ORDER, **errors(401, 403, 404, 422)})
    def get(self, request: Request, id: str) -> Response:
        return ok({"order": services.customer_get(current_user(request), parse_id(id))})


class OrderCancelView(APIView):
    permission_classes = [role_required(Role.CUSTOMER)]

    @extend_schema(
        tags=["Orders"],
        request=CancelInput,
        responses={200: ORDER, **errors(401, 403, 404, 409, 422)},
    )
    def post(self, request: Request, id: str) -> Response:
        order_id = parse_id(id)
        data = validated(CancelInput, request.data)
        order = services.customer_cancel(current_user(request), order_id, data.get("reason"))
        return ok({"order": order}, message="Order cancelled")


# ---------------------------------------------------------------------------
# Restaurant partner
# ---------------------------------------------------------------------------
class RestaurantListQuery(PageQuery):
    view = _choice(["active", "history"], "Invalid value", required=False)
    status = _choice(S.values, "Invalid value", required=False)


class RestaurantStatusInput(serializers.Serializer):
    status = _choice(
        [S.CONFIRMED, S.REJECTED, S.PREPARING, S.READY_FOR_PICKUP],
        "Status must be confirmed, rejected, preparing or ready_for_pickup",
    )
    reason = reason_field()
    # With "confirmed": how long the food takes (the restaurant's usual time when left out).
    prep_minutes = serializers.IntegerField(
        required=False,
        min_value=5,
        max_value=120,
        error_messages=dict.fromkeys(
            ("invalid", "min_value", "max_value"), "Preparation time must be 5 to 120 minutes"
        ),
    )


PARTNER = [role_required(Role.RESTAURANT)]


class MyOrdersView(APIView):
    permission_classes = PARTNER

    @extend_schema(
        tags=["My restaurant"],
        operation_id="my_restaurant_orders_list",
        parameters=[RestaurantListQuery],
        responses={200: ORDER_LIST, **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(RestaurantListQuery, request.query_params)
        return ok(services.restaurant_list(current_user(request), query, Page.from_query(query)))


class MyStatsView(APIView):
    permission_classes = PARTNER

    @extend_schema(
        tags=["My restaurant"],
        responses={200: envelope("RestaurantStats"), **errors(401, 403, 404)},
    )
    def get(self, request: Request) -> Response:
        return ok(services.restaurant_stats(current_user(request)))


class MyOrderView(APIView):
    permission_classes = PARTNER

    @extend_schema(
        tags=["My restaurant"],
        operation_id="my_restaurant_orders_get",
        responses={200: ORDER, **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        return ok({"order": services.restaurant_get(current_user(request), parse_id(id))})


class MyOrderStatusView(APIView):
    permission_classes = PARTNER

    @extend_schema(
        tags=["My restaurant"],
        request=RestaurantStatusInput,
        responses={200: ORDER, **errors(400, 401, 403, 404, 409, 422)},
    )
    def patch(self, request: Request, id: str) -> Response:
        order_id = parse_id(id)
        data = validated(RestaurantStatusInput, request.data)
        order = services.restaurant_set_status(
            current_user(request),
            order_id,
            data["status"],
            data.get("reason"),
            data.get("prep_minutes"),
        )
        return ok({"order": order}, message=STATUS_MESSAGE[data["status"]])


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
class AdminOrderListQuery(PageQuery):
    status = _choice([*S.values, "active"], "Invalid value", required=False)


class AdminCancelInput(serializers.Serializer):
    reason = reason_field(required=True)


class AdminUnassignInput(serializers.Serializer):
    reason = reason_field()


class AdminOrdersView(APIView):
    permission_classes = [permission_required(Permission.ORDERS_VIEW)]

    @extend_schema(
        tags=["Admin: orders"],
        parameters=[AdminOrderListQuery],
        responses={200: ORDER_LIST, **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(AdminOrderListQuery, request.query_params)
        return ok(services.admin_list(query, Page.from_query(query)))


class AdminOrderView(APIView):
    permission_classes = [permission_required(Permission.ORDERS_VIEW)]

    @extend_schema(
        tags=["Admin: orders"],
        operation_id="admin_orders_get",
        responses={200: ORDER, **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        return ok({"order": services.admin_get(parse_id(id))})


class AdminOrderCancelView(APIView):
    permission_classes = [permission_required(Permission.ORDERS_MANAGE)]

    @extend_schema(
        tags=["Admin: orders"],
        operation_id="admin_orders_cancel",
        request=AdminCancelInput,
        responses={200: ORDER, **errors(401, 403, 404, 409, 422)},
    )
    @audited("order.cancel", "order", lambda req: f"Cancelled order: {req.data.get('reason', '')}")
    def post(self, request: Request, id: str) -> Response:
        order_id = parse_id(id)
        data = validated(AdminCancelInput, request.data)
        order = services.admin_cancel(current_user(request), order_id, data["reason"])
        return ok({"order": order}, message="Order cancelled")


class AdminOrderUnassignView(APIView):
    permission_classes = [permission_required(Permission.ORDERS_MANAGE)]

    @extend_schema(
        tags=["Admin: orders"],
        request=AdminUnassignInput,
        responses={200: ORDER, **errors(401, 403, 404, 409, 422)},
    )
    @audited(
        "order.unassign",
        "order",
        lambda req: ": ".join(
            p for p in ("Unassigned the rider", str(req.data.get("reason") or "").strip()) if p
        ),
    )
    def post(self, request: Request, id: str) -> Response:
        order_id = parse_id(id)
        data = validated(AdminUnassignInput, request.data)
        order = services.admin_unassign(current_user(request), order_id, data.get("reason"))
        return ok({"order": order}, message="Rider unassigned; looking for another rider")


# ---------------------------------------------------------------------------
# Phase 11: timeline, manual assignment, delivery code reset
# ---------------------------------------------------------------------------
TIMELINE = envelope("OrderTimeline")


class OrderTimelineView(APIView):
    permission_classes = [role_required(Role.CUSTOMER)]

    @extend_schema(
        tags=["Orders"],
        operation_id="orders_timeline",
        responses={200: TIMELINE, **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        return ok(services.customer_timeline(current_user(request), parse_id(id)))


class AdminOrderTimelineView(APIView):
    permission_classes = [permission_required(Permission.ORDERS_VIEW)]

    @extend_schema(
        tags=["Admin: orders"],
        operation_id="admin_orders_timeline",
        responses={200: TIMELINE, **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        return ok(services.admin_timeline(parse_id(id)))


class AdminAssignInput(serializers.Serializer):
    rider_id = UUIDRef(
        message="Choose a delivery partner",
        error_messages={
            "required": "Choose a delivery partner",
            "null": "Choose a delivery partner",
        },
    )


class AdminOrderAssignView(APIView):
    permission_classes = [permission_required(Permission.ORDERS_MANAGE)]

    @extend_schema(
        tags=["Admin: orders"],
        request=AdminAssignInput,
        responses={200: ORDER, **errors(401, 403, 404, 409, 422)},
    )
    @audited("order.assign", "order", lambda req: "Assigned a rider manually")
    def post(self, request: Request, id: str) -> Response:
        order_id = parse_id(id)
        data = validated(AdminAssignInput, request.data)
        order = services.admin_assign(current_user(request), order_id, data["rider_id"])
        return ok({"order": order}, message="Rider assigned")


class AdminOrderDeliveryCodeView(APIView):
    permission_classes = [permission_required(Permission.ORDERS_MANAGE)]

    @extend_schema(
        tags=["Admin: orders"],
        request=None,
        responses={200: ORDER, **errors(401, 403, 404, 409, 422)},
    )
    @audited("order.delivery_code", "order", lambda req: "Issued a new delivery code")
    def post(self, request: Request, id: str) -> Response:
        order = services.admin_reset_delivery_otp(current_user(request), parse_id(id))
        return ok({"order": order}, message="New delivery code sent to the customer")
