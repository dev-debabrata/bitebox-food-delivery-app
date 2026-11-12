"""
/restaurants (public), /my/restaurant (partner) and /admin/restaurants (Node: catalog, my-restaurant
and admin-catalog routes). Partner endpoints always act on the signed-in owner's restaurant.
"""

import re

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from apps.audit.services import audited
from apps.menus import services as menus
from apps.rbac.roles import Permission, Role
from common.api import ApiError, ok
from common.http import PublicCacheMixin
from common.pagination import Page
from common.permissions import permission_required, role_required
from common.schema import envelope, errors
from common.validation import parse_id, validated

from . import services
from .presenters import restaurant_json
from .serializers import (
    AcceptingOrdersInput,
    AdminListQuery,
    AdminStatusInput,
    PublicListQuery,
    RestaurantInput,
)

SLUG_OR_ID = re.compile(r"^[a-z0-9-]{1,80}$", re.IGNORECASE)
ANY = envelope("RestaurantResponse")  # data shapes follow docs/DOCUMENTATION.md §14


def _slug_or_id(value: str) -> str:
    if not SLUG_OR_ID.match(value):
        raise ApiError(
            422,
            "Validation failed",
            code="VALIDATION_ERROR",
            details=[{"field": "slugOrId", "message": "Invalid value"}],
        )
    return value


# --- public ---------------------------------------------------------------------------------------


class PublicListView(PublicCacheMixin, APIView):
    @extend_schema(
        tags=["Catalogue"],
        parameters=[
            OpenApiParameter(n, str)
            for n in (
                "search",
                "cuisine",
                "category",
                "veg",
                "sort",
                "lat",
                "lng",
                "radiusKm",
                "page",
                "limit",
            )
        ],
        responses={200: ANY, **errors(400, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(PublicListQuery, request.query_params)
        return ok(services.list_public(query, Page.from_query(query, default_limit=12)))


class CuisinesView(PublicCacheMixin, APIView):
    @extend_schema(tags=["Catalogue"], responses={200: ANY})
    def get(self, request: Request) -> Response:
        return ok({"cuisines": services.list_cuisines()})


class PublicDetailView(PublicCacheMixin, APIView):
    @extend_schema(
        tags=["Catalogue"],
        operation_id="restaurants_detail",
        responses={200: ANY, **errors(404, 422)},
    )
    def get(self, request: Request, slug_or_id: str) -> Response:
        restaurant = services.get_public(_slug_or_id(slug_or_id))
        return ok({"restaurant": restaurant_json(restaurant, owner="public")})


class PublicMenuView(PublicCacheMixin, APIView):
    @extend_schema(tags=["Catalogue"], responses={200: ANY, **errors(404, 422)})
    def get(self, request: Request, slug_or_id: str) -> Response:
        restaurant = services.get_public(_slug_or_id(slug_or_id))
        return ok({"sections": menus.public_menu(restaurant)})


# --- partner --------------------------------------------------------------------------------------

PARTNER = [role_required(Role.RESTAURANT)]


class MyRestaurantView(APIView):
    permission_classes = PARTNER

    @extend_schema(tags=["Partner"], responses={200: ANY, **errors(401, 403)})
    def get(self, request: Request) -> Response:
        restaurant = services.own_restaurant(current_user(request))
        return ok(
            {
                "restaurant": restaurant_json(restaurant) if restaurant else None,
                "stats": services.owner_stats(restaurant) if restaurant else None,
            }
        )

    @extend_schema(
        tags=["Partner"],
        request=RestaurantInput,
        responses={201: ANY, **errors(401, 403, 409, 422)},
    )
    def post(self, request: Request) -> Response:
        restaurant = services.create_own(
            current_user(request), validated(RestaurantInput, request.data)
        )
        return ok(
            {"restaurant": restaurant_json(restaurant)},
            message="Restaurant submitted for approval",
            status=201,
        )

    @extend_schema(
        tags=["Partner"],
        request=RestaurantInput,
        responses={200: ANY, **errors(401, 403, 404, 422)},
    )
    def patch(self, request: Request) -> Response:
        data = validated(RestaurantInput, request.data, partial=True)
        restaurant = services.update_own(current_user(request), data)
        return ok({"restaurant": restaurant_json(restaurant)}, message="Restaurant details saved")


class AcceptingOrdersView(APIView):
    permission_classes = PARTNER

    @extend_schema(
        tags=["Partner"],
        request=AcceptingOrdersInput,
        responses={200: ANY, **errors(401, 403, 404, 422)},
    )
    def patch(self, request: Request) -> Response:
        accepting = validated(AcceptingOrdersInput, request.data)["is_accepting_orders"]
        restaurant = services.set_accepting_orders(current_user(request), accepting)
        return ok(
            {"restaurant": restaurant_json(restaurant)},
            message="You are accepting orders"
            if restaurant.is_accepting_orders
            else "Orders paused",
        )


# --- admin ----------------------------------------------------------------------------------------

RESTAURANTS_MANAGE = [permission_required(Permission.RESTAURANTS_MANAGE)]


class AdminListView(APIView):
    permission_classes = RESTAURANTS_MANAGE

    @extend_schema(
        tags=["Admin: restaurants"],
        parameters=[OpenApiParameter(n, str) for n in ("status", "search", "page", "limit")],
        responses={200: ANY, **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(AdminListQuery, request.query_params)
        return ok(services.admin_list(query, Page.from_query(query)))


class AdminCountsView(APIView):
    permission_classes = RESTAURANTS_MANAGE

    @extend_schema(tags=["Admin: restaurants"], responses={200: ANY, **errors(401, 403)})
    def get(self, request: Request) -> Response:
        return ok({"counts": services.admin_counts()})


class AdminDetailView(APIView):
    permission_classes = RESTAURANTS_MANAGE

    @extend_schema(
        tags=["Admin: restaurants"],
        operation_id="admin_restaurants_detail",
        responses={200: ANY, **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        restaurant = services.admin_get(parse_id(id))
        return ok(
            {
                "restaurant": restaurant_json(restaurant, owner="admin"),
                "stats": services.owner_stats(restaurant),
            }
        )


class AdminStatusView(APIView):
    permission_classes = RESTAURANTS_MANAGE

    @extend_schema(
        tags=["Admin: restaurants"],
        request=AdminStatusInput,
        responses={200: ANY, **errors(400, 401, 403, 404, 409, 422)},
    )
    @audited(
        "restaurant.status",
        "restaurant",
        lambda r: ": ".join(
            x
            for x in (f"Set restaurant status to {r.data.get('status')}", r.data.get("reason"))
            if x
        ),
    )
    def patch(self, request: Request, id: str) -> Response:
        data = validated(AdminStatusInput, request.data)
        restaurant = services.admin_set_status(
            parse_id(id), data["status"], (data.get("reason") or "").strip(), current_user(request)
        )
        return ok(
            {"restaurant": restaurant_json(restaurant, owner="admin")},
            message=f"Restaurant {restaurant.status}",
        )
