"""Public /categories and /foods, partner /my/restaurant/foods, /admin/categories, /admin/foods."""

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from apps.audit.services import audited
from apps.rbac.roles import Permission, Role
from apps.restaurants.services import require_own_restaurant
from common.api import ok
from common.http import PublicCacheMixin
from common.pagination import Page
from common.permissions import permission_required, role_required
from common.schema import envelope, errors
from common.validation import parse_id, validated

from . import services
from .presenters import category_json, food_json
from .serializers import (
    AdminFoodListQuery,
    AvailabilityInput,
    CategoryInput,
    FoodInput,
    FoodListQuery,
    PublicFoodQuery,
)

ANY = envelope("MenuResponse")
LIST = [
    OpenApiParameter(n, str) for n in ("search", "category", "available", "veg", "page", "limit")
]


# --- public ---------------------------------------------------------------------------------------


class CategoriesView(PublicCacheMixin, APIView):
    @extend_schema(tags=["Catalogue"], responses={200: ANY})
    def get(self, request: Request) -> Response:
        return ok({"categories": services.list_active_categories()})


class FoodSearchView(PublicCacheMixin, APIView):
    @extend_schema(tags=["Catalogue"], parameters=LIST, responses={200: ANY, **errors(422)})
    def get(self, request: Request) -> Response:
        query = validated(PublicFoodQuery, request.query_params)
        return ok(services.public_search(query, Page.from_query(query, default_limit=12)))


class FoodDetailView(PublicCacheMixin, APIView):
    @extend_schema(
        tags=["Catalogue"], operation_id="foods_detail", responses={200: ANY, **errors(404, 422)}
    )
    def get(self, request: Request, id: str) -> Response:
        return ok({"item": services.public_get(parse_id(id))})


# --- partner --------------------------------------------------------------------------------------

PARTNER = [role_required(Role.RESTAURANT)]


class MyFoodsView(APIView):
    permission_classes = PARTNER

    @extend_schema(
        tags=["Partner"], parameters=LIST, responses={200: ANY, **errors(401, 403, 404, 422)}
    )
    def get(self, request: Request) -> Response:
        restaurant = require_own_restaurant(current_user(request))
        query = validated(FoodListQuery, request.query_params)
        return ok(services.owner_list(restaurant, query, Page.from_query(query, default_limit=50)))

    @extend_schema(
        tags=["Partner"], request=FoodInput, responses={201: ANY, **errors(401, 403, 404, 409, 422)}
    )
    def post(self, request: Request) -> Response:
        restaurant = require_own_restaurant(current_user(request))
        item = services.owner_create(restaurant, validated(FoodInput, request.data))
        return ok({"item": food_json(item)}, message="Menu item added", status=201)


class MyFoodView(APIView):
    permission_classes = PARTNER

    @extend_schema(
        tags=["Partner"], request=FoodInput, responses={200: ANY, **errors(401, 403, 404, 409, 422)}
    )
    def patch(self, request: Request, id: str) -> Response:
        restaurant = require_own_restaurant(current_user(request))
        item = services.owner_update(
            restaurant, parse_id(id), validated(FoodInput, request.data, partial=True)
        )
        return ok({"item": food_json(item)}, message="Menu item saved")

    @extend_schema(tags=["Partner"], responses={200: ANY, **errors(401, 403, 404, 422)})
    def delete(self, request: Request, id: str) -> Response:
        restaurant = require_own_restaurant(current_user(request))
        services.owner_delete(restaurant, parse_id(id))
        return ok(message="Menu item deleted")


class MyFoodAvailabilityView(APIView):
    permission_classes = PARTNER

    @extend_schema(
        tags=["Partner"],
        request=AvailabilityInput,
        responses={200: ANY, **errors(401, 403, 404, 422)},
    )
    def patch(self, request: Request, id: str) -> Response:
        item_id = parse_id(id)
        restaurant = require_own_restaurant(current_user(request))
        available = validated(AvailabilityInput, request.data)["is_available"]
        item = services.owner_set_availability(restaurant, item_id, available)
        return ok(
            {"item": food_json(item)},
            message="Item is available" if item.is_available else "Item marked unavailable",
        )


# --- admin ----------------------------------------------------------------------------------------

CATALOG = [permission_required(Permission.CATALOG_MANAGE)]
RESTAURANTS = [permission_required(Permission.RESTAURANTS_MANAGE)]


class AdminCategoriesView(APIView):
    permission_classes = CATALOG

    @extend_schema(tags=["Admin: catalogue"], responses={200: ANY, **errors(401, 403)})
    def get(self, request: Request) -> Response:
        return ok({"categories": services.admin_list_categories()})

    @extend_schema(
        tags=["Admin: catalogue"],
        request=CategoryInput,
        responses={201: ANY, **errors(401, 403, 409, 422)},
    )
    def post(self, request: Request) -> Response:
        category = services.create_category(validated(CategoryInput, request.data))
        return ok({"category": category_json(category)}, message="Category created", status=201)


class AdminCategoryView(APIView):
    permission_classes = CATALOG

    @extend_schema(
        tags=["Admin: catalogue"],
        request=CategoryInput,
        responses={200: ANY, **errors(401, 403, 404, 409, 422)},
    )
    def patch(self, request: Request, id: str) -> Response:
        category = services.update_category(
            parse_id(id), validated(CategoryInput, request.data, partial=True)
        )
        return ok({"category": category_json(category)}, message="Category saved")

    @extend_schema(
        tags=["Admin: catalogue"], responses={200: ANY, **errors(401, 403, 404, 409, 422)}
    )
    @audited("category.delete", "category", lambda r: "Deleted food category")
    def delete(self, request: Request, id: str) -> Response:
        services.delete_category(parse_id(id))
        return ok(message="Category deleted")


class AdminFoodsView(APIView):
    permission_classes = RESTAURANTS

    @extend_schema(
        tags=["Admin: catalogue"],
        parameters=[*LIST, OpenApiParameter("restaurant", str)],
        responses={200: ANY, **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(AdminFoodListQuery, request.query_params)
        return ok(services.admin_list(query, Page.from_query(query)))


class AdminFoodAvailabilityView(APIView):
    permission_classes = RESTAURANTS

    @extend_schema(
        tags=["Admin: catalogue"],
        request=AvailabilityInput,
        responses={200: ANY, **errors(401, 403, 404, 422)},
    )
    def patch(self, request: Request, id: str) -> Response:
        item_id = parse_id(id)
        item = services.admin_set_availability(
            item_id, validated(AvailabilityInput, request.data)["is_available"]
        )
        return ok({"item": item}, message="Availability updated")


class AdminFoodView(APIView):
    permission_classes = RESTAURANTS

    @extend_schema(tags=["Admin: catalogue"], responses={200: ANY, **errors(401, 403, 404, 422)})
    @audited("food.delete", "food", lambda r: "Deleted menu item")
    def delete(self, request: Request, id: str) -> Response:
        services.admin_delete(parse_id(id))
        return ok(message="Menu item deleted")
