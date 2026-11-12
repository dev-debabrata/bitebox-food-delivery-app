"""/api/v1/cart (customers only). Every change answers with the fresh server-side quote."""

from collections.abc import Callable
from typing import Any

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from apps.accounts.models import User
from apps.rbac.roles import Role
from common.api import ok
from common.fields import UUIDRef
from common.permissions import role_required
from common.schema import envelope, errors
from common.throttling import rate_limit
from common.validation import parse_id, validated

from . import services
from .models import MAX_ITEM_QUANTITY

CUSTOMER = [role_required(Role.CUSTOMER)]
QUOTE = envelope("CartQuote")
ADDRESS_PARAM = [OpenApiParameter("addressId", str)]


class QuoteQuery(serializers.Serializer):
    address_id = UUIDRef(message="Invalid address", required=False)


class AddItemInput(serializers.Serializer):
    food_item_id = UUIDRef(message="Invalid dish", error_messages={"required": "Invalid dish"})
    quantity = serializers.IntegerField(
        required=False,
        min_value=1,
        max_value=MAX_ITEM_QUANTITY,
        error_messages={
            k: f"Quantity must be 1-{MAX_ITEM_QUANTITY}"
            for k in ("min_value", "max_value", "invalid")
        },
    )
    replace = serializers.BooleanField(required=False)


class QuantityInput(serializers.Serializer):
    quantity = serializers.IntegerField(
        min_value=0,
        max_value=MAX_ITEM_QUANTITY,
        error_messages={
            k: f"Quantity must be 0-{MAX_ITEM_QUANTITY}"
            for k in ("min_value", "max_value", "invalid", "required")
        },
    )


class CartCouponInput(serializers.Serializer):
    code = serializers.RegexField(
        r"^[A-Za-z0-9_-]{3,30}$",
        error_messages={
            "invalid": "Enter a valid coupon code",
            "required": "Enter a valid coupon code",
        },
    )


class CoinsInput(serializers.Serializer):
    coins = serializers.IntegerField(min_value=0, max_value=10_000_000)


def _respond(
    request: Request, change: Callable[[User], Any] | None, message: str = "OK"
) -> Response:
    user = current_user(request)
    address = validated(QuoteQuery, request.query_params).get("address_id")
    if change is not None:
        change(user)
    return ok(services.build_quote(user, address), message=message)


class CartView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Cart"],
        parameters=ADDRESS_PARAM,
        responses={200: QUOTE, **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request) -> Response:
        return _respond(request, None)

    @extend_schema(
        tags=["Cart"], parameters=ADDRESS_PARAM, responses={200: QUOTE, **errors(401, 403)}
    )
    def delete(self, request: Request) -> Response:
        return _respond(request, services.clear, "Cart cleared")


class CartItemsView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Cart"],
        parameters=ADDRESS_PARAM,
        request=AddItemInput,
        responses={200: QUOTE, **errors(401, 403, 404, 409, 422)},
    )
    def post(self, request: Request) -> Response:
        data = validated(AddItemInput, request.data)
        return _respond(
            request,
            lambda u: services.add_item(
                u, data["food_item_id"], data.get("quantity", 1), data.get("replace", False)
            ),
            "Added to cart",
        )


class CartItemView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Cart"],
        parameters=ADDRESS_PARAM,
        request=QuantityInput,
        responses={200: QUOTE, **errors(401, 403, 404, 409, 422)},
    )
    def patch(self, request: Request, food_item_id: str) -> Response:
        item_id = parse_id(food_item_id, "foodItemId")
        quantity = validated(QuantityInput, request.data)["quantity"]
        return _respond(
            request, lambda u: services.set_quantity(u, item_id, quantity), "Cart updated"
        )

    @extend_schema(
        tags=["Cart"],
        parameters=ADDRESS_PARAM,
        responses={200: QUOTE, **errors(401, 403, 404, 422)},
    )
    def delete(self, request: Request, food_item_id: str) -> Response:
        item_id = parse_id(food_item_id, "foodItemId")
        return _respond(request, lambda u: services.remove_item(u, item_id), "Removed from cart")


class CartCouponView(APIView):
    permission_classes = CUSTOMER

    def get_throttles(self) -> list[Any]:
        # Slow down coupon-code guessing (applying only).
        if self.request.method == "POST":
            return [rate_limit("COUPON_RATE_LIMIT", "Too many coupon attempts. Try again later.")()]
        return []

    @extend_schema(
        tags=["Cart"],
        parameters=ADDRESS_PARAM,
        request=CartCouponInput,
        responses={200: QUOTE, **errors(400, 401, 403, 422, 429)},
    )
    def post(self, request: Request) -> Response:
        code = validated(CartCouponInput, request.data)["code"]
        return _respond(request, lambda u: services.apply_coupon(u, code), "Coupon applied")

    @extend_schema(
        tags=["Cart"], parameters=ADDRESS_PARAM, responses={200: QUOTE, **errors(401, 403)}
    )
    def delete(self, request: Request) -> Response:
        return _respond(request, services.remove_coupon, "Coupon removed")


class CartCoinsView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Cart"],
        parameters=ADDRESS_PARAM,
        request=CoinsInput,
        responses={200: QUOTE, **errors(400, 401, 403, 422)},
    )
    def put(self, request: Request) -> Response:
        amount = validated(CoinsInput, request.data)["coins"]
        return _respond(request, lambda u: services.set_coins(u, amount), "Coins applied")

    @extend_schema(
        tags=["Cart"], parameters=ADDRESS_PARAM, responses={200: QUOTE, **errors(401, 403)}
    )
    def delete(self, request: Request) -> Response:
        return _respond(request, services.remove_coins, "Coins removed")
