"""/my/restaurant/reviews/*: the restaurant panel's reviews page (Node: my-restaurant.routes)."""

from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from apps.rbac.roles import Role
from common.api import ok
from common.fields import QueryBoolean, UUIDRef
from common.pagination import Page
from common.permissions import role_required
from common.schema import envelope, errors
from common.validation import PageQuery, parse_id, validated

from . import services
from .models import RESPONSE_MAX, ReviewTarget

PARTNER = [role_required(Role.RESTAURANT)]
RESULT = envelope("RestaurantReviewsResult")


def _invalid(choices: list[str]) -> serializers.ChoiceField:
    keys = ("invalid_choice", "null", "blank")
    return serializers.ChoiceField(
        choices=choices,
        required=False,
        error_messages=dict.fromkeys(keys, "Invalid value"),
    )


class RestaurantReviewQuery(PageQuery):
    target = _invalid([ReviewTarget.RESTAURANT, ReviewTarget.FOOD])
    food_item_id = UUIDRef(message="Invalid value", required=False)
    rating = serializers.IntegerField(
        required=False,
        min_value=1,
        max_value=5,
        error_messages=dict.fromkeys(("invalid", "min_value", "max_value"), "Invalid value"),
    )
    responded = QueryBoolean()
    sort = _invalid(["newest", "oldest", "highest", "lowest"])


class ResponseInput(serializers.Serializer):
    text = serializers.CharField(
        min_length=2,
        max_length=RESPONSE_MAX,
        trim_whitespace=True,
        error_messages={
            "required": "Write a reply",
            "null": "Write a reply",
            "invalid": "Write a reply",
            "blank": f"The reply must be 2 to {RESPONSE_MAX} characters",
            "min_length": f"The reply must be 2 to {RESPONSE_MAX} characters",
            "max_length": f"The reply must be 2 to {RESPONSE_MAX} characters",
        },
    )


class ReviewOrdersView(APIView):
    permission_classes = PARTNER

    @extend_schema(
        tags=["My restaurant"],
        parameters=[RestaurantReviewQuery],
        responses={200: RESULT, **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(RestaurantReviewQuery, request.query_params)
        page = Page.from_query(query, default_limit=10)
        return ok(services.restaurant_orders(current_user(request), query, page))


class ReviewOrderView(APIView):
    permission_classes = PARTNER

    @extend_schema(
        tags=["My restaurant"],
        operation_id="my_restaurant_review_order_get",
        responses={200: RESULT, **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, order_id: str) -> Response:
        oid = parse_id(order_id, "orderId")
        return ok(services.restaurant_order(current_user(request), oid))


class ReviewSummaryView(APIView):
    permission_classes = PARTNER

    @extend_schema(tags=["My restaurant"], responses={200: RESULT, **errors(401, 403, 404)})
    def get(self, request: Request) -> Response:
        return ok(services.restaurant_summary(current_user(request)))


class ReviewResponseView(APIView):
    permission_classes = PARTNER

    @extend_schema(
        tags=["My restaurant"],
        request=ResponseInput,
        responses={200: RESULT, **errors(401, 403, 404, 422)},
    )
    def put(self, request: Request, id: str) -> Response:
        review_id = parse_id(id)
        data = validated(ResponseInput, request.data)
        review = services.respond(current_user(request), review_id, data["text"])
        return ok({"review": review}, message="Reply posted")

    @extend_schema(tags=["My restaurant"], responses={200: RESULT, **errors(401, 403, 404, 422)})
    def delete(self, request: Request, id: str) -> Response:
        review = services.delete_response(current_user(request), parse_id(id))
        return ok({"review": review}, message="Reply removed")
