"""Views that exist only in tests, to exercise the error contract end to end."""

from django.urls import path, re_path
from rest_framework import serializers
from rest_framework.exceptions import NotFound, PermissionDenied, Throttled
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.rbac.roles import Permission, Role
from common.api import ApiError, ok
from common.exceptions import route_not_found
from common.pagination import Page, paginate
from common.permissions import PUBLIC, permission_required, role_required


class LineSerializer(serializers.Serializer):
    food_item_id = serializers.CharField()
    quantity = serializers.IntegerField(min_value=1)


class AddressSerializer(serializers.Serializer):
    postal_code = serializers.RegexField(r"^\d{6}$")
    city = serializers.CharField()


class OrderInput(serializers.Serializer):
    payment_method = serializers.ChoiceField(choices=["cod", "online"])
    delivery_address = AddressSerializer()
    items = LineSerializer(many=True)


class Echo(APIView):
    permission_classes = PUBLIC

    def post(self, request: Request) -> Response:
        data = OrderInput(data=request.data)
        data.is_valid(raise_exception=True)
        return ok(data.validated_data, message="Order accepted", status=201)


class Boom(APIView):
    permission_classes = PUBLIC
    kinds = {
        "api": ApiError.conflict("That order changed. Reload and try again.", code="ORDER_CHANGED"),
        "forbidden": PermissionDenied(),
        "missing": NotFound(),
        "throttled": Throttled(wait=30),
        "crash": RuntimeError("secret internal detail"),
    }

    def get(self, request: Request, kind: str) -> Response:
        raise self.kinds[kind]


class Listing(APIView):
    permission_classes = PUBLIC

    def get(self, request: Request) -> Response:
        items, meta = paginate(list(range(1, 46)), Page.from_query(request.query_params))
        return ok({"items": items, "pagination": meta})


class AdminOnly(APIView):
    permission_classes = [permission_required(Permission.ORDERS_MANAGE)]

    def get(self, request: Request) -> Response:
        return ok()


class RiderOnly(APIView):
    permission_classes = [role_required(Role.DELIVERY)]

    def get(self, request: Request) -> Response:
        return ok()


urlpatterns = [
    path("api/v1/echo", Echo.as_view()),
    path("api/v1/boom/<str:kind>", Boom.as_view()),
    path("api/v1/listing", Listing.as_view()),
    path("api/v1/admin-only", AdminOnly.as_view()),
    path("api/v1/rider-only", RiderOnly.as_view()),
    re_path(r"^api/", route_not_found),
]
