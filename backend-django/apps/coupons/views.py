"""/api/v1/coupons/available (customers) and /admin/coupons (catalog:manage)."""

from typing import Any

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.rbac.roles import Permission, Role
from common.api import ok
from common.fields import QueryBoolean, UUIDRef
from common.pagination import Page
from common.permissions import permission_required, role_required
from common.schema import envelope, errors
from common.validation import PageQuery, parse_id, validated

from . import services
from .models import DiscountType

ANY = envelope("CouponResponse")
ADMIN = [permission_required(Permission.CATALOG_MANAGE)]


class NullableInt(serializers.IntegerField):
    """A whole number of at least `min_value`, or null (which clears it)."""

    def __init__(self, field: str, min_value: int, **kwargs: Any) -> None:
        message = f"{field} must be a whole number of at least {min_value}, or null"
        super().__init__(
            min_value=min_value,
            required=False,
            allow_null=True,
            error_messages={k: message for k in ("min_value", "invalid")},
            **kwargs,
        )


class CouponInput(serializers.Serializer):
    code = serializers.RegexField(
        r"^[A-Za-z0-9_-]{3,30}$",
        error_messages={
            "invalid": "Code: 3-30 letters, digits, - or _",
            "required": "Code: 3-30 letters, digits, - or _",
        },
    )
    description = serializers.CharField(max_length=200, required=False, allow_blank=True)
    discount_type = serializers.ChoiceField(
        choices=DiscountType.values,
        error_messages={
            "invalid_choice": "Choose percent or flat",
            "required": "Choose percent or flat",
        },
    )
    discount_value = serializers.IntegerField(
        min_value=1,
        error_messages={
            k: "Discount must be a positive whole number"
            for k in ("min_value", "invalid", "required")
        },
    )
    max_discount_paise = NullableInt("maxDiscountPaise", 0)
    min_order_paise = serializers.IntegerField(min_value=0, required=False)
    valid_from = serializers.DateTimeField(
        error_messages={"invalid": "Invalid start date", "required": "Invalid start date"}
    )
    valid_until = serializers.DateTimeField(
        error_messages={"invalid": "Invalid end date", "required": "Invalid end date"}
    )
    is_active = serializers.BooleanField(required=False)
    usage_limit = NullableInt("usageLimit", 1)
    per_user_limit = serializers.IntegerField(min_value=1, max_value=100, required=False)
    restaurant = UUIDRef(message="Invalid restaurant", required=False, allow_null=True)

    def to_internal_value(self, data: Any) -> Any:
        value = super().to_internal_value(data)
        if "code" in value:
            value["code"] = value["code"].strip().upper()
        return value


class AdminQuery(PageQuery):
    active = QueryBoolean()


class AvailableQuery(serializers.Serializer):
    restaurant_id = UUIDRef(required=False)


class AvailableView(APIView):
    permission_classes = [role_required(Role.CUSTOMER)]

    @extend_schema(
        tags=["Coupons"],
        parameters=[OpenApiParameter("restaurantId", str)],
        responses={200: ANY, **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(AvailableQuery, request.query_params)
        return ok({"coupons": services.list_available(query.get("restaurant_id"))})


class AdminCouponsView(APIView):
    permission_classes = ADMIN

    @extend_schema(
        tags=["Admin: coupons"],
        parameters=[OpenApiParameter(n, str) for n in ("search", "active", "page", "limit")],
        responses={200: ANY, **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(AdminQuery, request.query_params)
        return ok(services.admin_list(query, Page.from_query(query)))

    @extend_schema(
        tags=["Admin: coupons"],
        request=CouponInput,
        responses={201: ANY, **errors(401, 403, 409, 422)},
    )
    def post(self, request: Request) -> Response:
        coupon = services.create(validated(CouponInput, request.data))
        return ok({"coupon": services.coupon_json(coupon)}, message="Coupon created", status=201)


class AdminCouponView(APIView):
    permission_classes = ADMIN

    @extend_schema(
        tags=["Admin: coupons"],
        request=CouponInput,
        responses={200: ANY, **errors(401, 403, 404, 409, 422)},
    )
    def patch(self, request: Request, id: str) -> Response:
        coupon_id = parse_id(id)
        coupon = services.update(coupon_id, validated(CouponInput, request.data, partial=True))
        return ok({"coupon": services.coupon_json(coupon)}, message="Coupon saved")

    @extend_schema(tags=["Admin: coupons"], responses={200: ANY, **errors(401, 403, 404, 409, 422)})
    def delete(self, request: Request, id: str) -> Response:
        services.remove(parse_id(id))
        return ok(None, message="Coupon deleted")
