"""/api/v1/addresses: a customer's saved addresses (others' are always 404)."""

from typing import Any

from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from apps.rbac.roles import Role
from apps.restaurants.serializers import LocationInput
from common.api import ok
from common.permissions import role_required
from common.schema import envelope, errors
from common.validation import parse_id, validated

from . import services
from .models import AddressLabel

CUSTOMER = [role_required(Role.CUSTOMER)]
ANY = envelope("AddressResponse")


def _text(lo: int, hi: int, message: str, **kw: Any) -> serializers.CharField:
    return serializers.CharField(
        min_length=lo,
        max_length=hi,
        error_messages={k: message for k in ("min_length", "max_length", "blank", "required")},
        **kw,
    )


class SavedAddressInput(serializers.Serializer):
    label = serializers.ChoiceField(choices=AddressLabel.values, required=False)  # type: ignore[assignment]
    recipient_name = _text(2, 80, "Name must be 2-80 characters")
    phone = serializers.RegexField(
        r"^\+?[0-9]{10,15}$",
        error_messages={
            "invalid": "Enter a valid phone number",
            "required": "Enter a valid phone number",
        },
    )
    line1 = _text(3, 120, "House / flat and street are required")
    line2 = serializers.CharField(max_length=120, required=False, allow_blank=True)
    area = serializers.CharField(max_length=80, required=False, allow_blank=True)
    landmark = serializers.CharField(max_length=80, required=False, allow_blank=True)
    city = _text(2, 60, "City is required")
    state = _text(2, 60, "State is required")
    postal_code = serializers.RegexField(
        r"^[A-Za-z0-9 -]{3,10}$",
        error_messages={"invalid": "Enter a valid PIN code", "required": "Enter a valid PIN code"},
    )
    location = LocationInput(
        error_messages={"required": "Pin the location", "invalid": "Pin the location"}
    )
    is_default = serializers.BooleanField(required=False)


class AddressesView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(tags=["Addresses"], responses={200: ANY, **errors(401, 403)})
    def get(self, request: Request) -> Response:
        return ok(
            {
                "addresses": [
                    services.address_json(a) for a in services.list_for(current_user(request))
                ]
            }
        )

    @extend_schema(
        tags=["Addresses"],
        request=SavedAddressInput,
        responses={201: ANY, **errors(401, 403, 409, 422)},
    )
    def post(self, request: Request) -> Response:
        address = services.create(current_user(request), validated(SavedAddressInput, request.data))
        return ok({"address": services.address_json(address)}, message="Address saved", status=201)


class AddressView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Addresses"],
        request=SavedAddressInput,
        responses={200: ANY, **errors(401, 403, 404, 422)},
    )
    def patch(self, request: Request, id: str) -> Response:
        address_id = parse_id(id)
        data = validated(SavedAddressInput, request.data, partial=True)
        address = services.update(current_user(request), address_id, data)
        return ok({"address": services.address_json(address)}, message="Address updated")

    @extend_schema(tags=["Addresses"], responses={200: ANY, **errors(401, 403, 404, 422)})
    def delete(self, request: Request, id: str) -> Response:
        services.remove(current_user(request), parse_id(id))
        return ok(None, message="Address deleted")


class DefaultAddressView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Addresses"], request=None, responses={200: ANY, **errors(401, 403, 404, 422)}
    )
    def patch(self, request: Request, id: str) -> Response:
        address = services.set_default(current_user(request), parse_id(id))
        return ok({"address": services.address_json(address)}, message="Default address updated")
