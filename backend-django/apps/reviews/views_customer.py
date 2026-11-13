"""
Public review lists (Node: catalog.routes.js), a customer's reviews of an order (checkout.routes.js
orderReviews/reviewOrder) and /reviews (review.routes.js: write, edit, delete, report).
"""

import re

from drf_spectacular.utils import extend_schema
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from apps.rbac.roles import Role
from apps.restaurants import services as restaurants
from common.api import ApiError, ok
from common.http import PublicCacheMixin
from common.pagination import Page
from common.permissions import PUBLIC, role_required
from common.schema import envelope, errors
from common.throttling import rate_limit
from common.validation import parse_id, validated

from . import services
from .serializers import (
    CreateReviewInput,
    MyReviewsQuery,
    OrderRatingInput,
    PublicReviewQuery,
    ReportInput,
    UpdateReviewInput,
)

CUSTOMER = [role_required(Role.CUSTOMER)]
SLUG_OR_ID = re.compile(r"^[a-z0-9-]{1,80}$", re.IGNORECASE)
REVIEW_LIST = envelope("ReviewList")
REVIEW = envelope("ReviewResult")
ORDER_REVIEWS = envelope("OrderReviewState")


def _public_page(query: dict[str, object]) -> Page:
    return Page.from_query(query, default_limit=10, max_limit=50)


# --- public ---------------------------------------------------------------------------------------


class RestaurantReviewsView(PublicCacheMixin, APIView):
    permission_classes = PUBLIC

    @extend_schema(
        tags=["Catalogue"],
        parameters=[PublicReviewQuery],
        responses={200: REVIEW_LIST, **errors(404, 422)},
    )
    def get(self, request: Request, slug_or_id: str) -> Response:
        if not SLUG_OR_ID.match(slug_or_id):
            raise ApiError(
                422,
                "Validation failed",
                code="VALIDATION_ERROR",
                details=[{"field": "slugOrId", "message": "Invalid value"}],
            )
        query = validated(PublicReviewQuery, request.query_params)
        restaurant = restaurants.get_public(slug_or_id)
        return ok(services.public_restaurant_reviews(restaurant, query, _public_page(query)))


class FoodReviewsView(PublicCacheMixin, APIView):
    permission_classes = PUBLIC

    @extend_schema(
        tags=["Catalogue"],
        parameters=[PublicReviewQuery],
        responses={200: REVIEW_LIST, **errors(404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        food_id = parse_id(id)
        query = validated(PublicReviewQuery, request.query_params)
        return ok(services.public_food_reviews(food_id, query, _public_page(query)))


# --- customer: one order --------------------------------------------------------------------------


class OrderReviewsView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Orders"],
        operation_id="orders_reviews_get",
        responses={200: ORDER_REVIEWS, **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        return ok(services.order_reviews(current_user(request), parse_id(id)))

    @extend_schema(
        tags=["Orders"],
        operation_id="orders_reviews_create",
        request=OrderRatingInput,
        responses={201: ORDER_REVIEWS, **errors(401, 403, 404, 409, 422)},
    )
    def post(self, request: Request, id: str) -> Response:
        order_id = parse_id(id)
        data = validated(OrderRatingInput, request.data)
        state = services.review_order(current_user(request), order_id, data)
        return ok(state, message="Thanks for rating your order", status=201)


# --- customer: /reviews ---------------------------------------------------------------------------


class ReviewsView(APIView):
    permission_classes = CUSTOMER
    throttle_classes = [
        rate_limit("REVIEW_RATE_LIMIT", "Too many reviews at once. Please wait a moment.")
    ]

    @extend_schema(
        tags=["Reviews"],
        request=CreateReviewInput,
        responses={201: REVIEW, **errors(401, 403, 404, 409, 422, 429)},
    )
    def post(self, request: Request) -> Response:
        data = validated(CreateReviewInput, request.data)
        review = services.create(current_user(request), data)
        return ok({"review": review}, message="Thanks for your review", status=201)


class MyReviewsView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Reviews"],
        parameters=[MyReviewsQuery],
        responses={200: REVIEW_LIST, **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(MyReviewsQuery, request.query_params)
        page = Page.from_query(query, default_limit=10)
        return ok(services.list_mine(current_user(request), query, page))


class ReviewView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Reviews"],
        operation_id="reviews_get",
        responses={200: REVIEW, **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        return ok({"review": services.get_mine(current_user(request), parse_id(id))})

    @extend_schema(
        tags=["Reviews"],
        request=UpdateReviewInput,
        responses={200: REVIEW, **errors(400, 401, 403, 404, 409, 422)},
    )
    def patch(self, request: Request, id: str) -> Response:
        review_id = parse_id(id)
        data = validated(UpdateReviewInput, request.data)
        review = services.update(current_user(request), review_id, data)
        return ok({"review": review}, message="Review updated")

    @extend_schema(tags=["Reviews"], responses={200: REVIEW, **errors(401, 403, 404, 422)})
    def delete(self, request: Request, id: str) -> Response:
        return ok(services.remove(current_user(request), parse_id(id)), message="Review deleted")


class ReviewReportsView(APIView):
    """Customers, the reviewed restaurant and the reviewed rider may report a published review."""

    permission_classes = [role_required(Role.CUSTOMER, Role.RESTAURANT, Role.DELIVERY)]
    throttle_classes = [
        rate_limit("REVIEW_REPORT_RATE_LIMIT", "Too many reports. Try again later.")
    ]

    @extend_schema(
        tags=["Reviews"],
        request=ReportInput,
        responses={201: REVIEW, **errors(400, 401, 403, 404, 409, 422, 429)},
    )
    def post(self, request: Request, id: str) -> Response:
        review_id = parse_id(id)
        data = validated(ReportInput, request.data)
        result = services.report(current_user(request), review_id, data)
        return ok(result, message="Thanks. Our team will take a look.", status=201)
