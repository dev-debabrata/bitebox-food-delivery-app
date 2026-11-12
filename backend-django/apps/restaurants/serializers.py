"""Restaurant request validation (Node: validators/restaurant.validators.js)."""

import re
from typing import Any

from rest_framework import serializers

from apps.accounts.serializers import EmailField
from common.fields import ImageUrlField, PaiseField, QueryBoolean, UUIDRef
from common.validation import PageQuery

from .models import RestaurantStatus

TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
PHONE = re.compile(r"^\+?[0-9]{10,15}$")
POSTAL = re.compile(r"^[A-Za-z0-9 -]{3,10}$")


def _text(min_len: int, max_len: int, message: str, **kwargs: Any) -> serializers.CharField:
    return serializers.CharField(
        min_length=min_len,
        max_length=max_len,
        error_messages={
            "min_length": message,
            "max_length": message,
            "blank": message,
            "required": message,
        },
        **kwargs,
    )


class RestaurantAddressInput(serializers.Serializer):
    line1 = _text(3, 120, "Street address is required")
    line2 = serializers.CharField(max_length=120, required=False, allow_blank=True)
    area = serializers.CharField(max_length=80, required=False, allow_blank=True)
    city = _text(2, 60, "City is required")
    state = _text(2, 60, "State is required")
    postal_code = serializers.RegexField(
        POSTAL,
        error_messages={
            "invalid": "Enter a valid postal code",
            "required": "Enter a valid postal code",
        },
    )


class LocationInput(serializers.Serializer):
    latitude = serializers.FloatField(
        min_value=-90,
        max_value=90,
        error_messages={
            k: "Latitude must be -90 to 90"
            for k in ("min_value", "max_value", "invalid", "required")
        },
    )
    longitude = serializers.FloatField(
        min_value=-180,
        max_value=180,
        error_messages={
            k: "Longitude must be -180 to 180"
            for k in ("min_value", "max_value", "invalid", "required")
        },
    )


class TimeField(serializers.RegexField):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(
            TIME,
            error_messages={"invalid": "Use 24-hour HH:mm", "required": "Use 24-hour HH:mm"},
            **kwargs,
        )


class Cuisines(serializers.ListField):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(
            child=_text(2, 40, "Each cuisine must be 2-40 characters"),
            min_length=1,
            max_length=10,
            error_messages={
                k: "Add between 1 and 10 cuisines"
                for k in ("min_length", "max_length", "empty", "not_a_list", "required")
            },
            **kwargs,
        )


class RestaurantInput(serializers.Serializer):
    """Create (all required) or, with partial=True, update. Unknown fields (status, owner,
    rating...) are ignored."""

    name = _text(2, 100, "Name must be 2-100 characters")
    description = serializers.CharField(max_length=1000, required=False, allow_blank=True)
    cuisines = Cuisines()
    phone = serializers.RegexField(
        PHONE,
        error_messages={
            "invalid": "Enter a valid phone number",
            "required": "Enter a valid phone number",
        },
    )
    email = EmailField(
        required=False,
        allow_blank=True,
        allow_null=True,
        error_messages={"invalid": "Enter a valid email"},
    )
    address = RestaurantAddressInput(
        error_messages={"required": "Address is required", "invalid": "Address is required"}
    )
    location = LocationInput(
        error_messages={"required": "Location is required", "invalid": "Location is required"}
    )
    image_url = ImageUrlField()
    is_pure_veg = serializers.BooleanField(required=False)
    cost_for_two_paise = PaiseField(min_value=0)
    min_order_paise = PaiseField(min_value=0, required=False)
    avg_prep_time_minutes = serializers.IntegerField(
        min_value=5,
        max_value=180,
        required=False,
        error_messages={
            k: "Preparation time must be 5-180 minutes"
            for k in ("min_value", "max_value", "invalid")
        },
    )
    opening_time = TimeField()
    closing_time = TimeField()

    def to_internal_value(self, data: Any) -> Any:
        value = super().to_internal_value(data)
        if "cuisines" in value:
            value["cuisines"] = [c.strip() for c in value["cuisines"]]
        if value.get("email") is None and "email" in value:
            value["email"] = ""
        return value


class AcceptingOrdersInput(serializers.Serializer):
    is_accepting_orders = serializers.BooleanField(
        error_messages={
            "required": "isAcceptingOrders must be true or false",
            "invalid": "isAcceptingOrders must be true or false",
        }
    )


class PublicListQuery(PageQuery):
    cuisine = serializers.CharField(required=False, max_length=40, allow_blank=True)
    category = UUIDRef(message="Invalid category", required=False)
    veg = QueryBoolean()
    sort = serializers.ChoiceField(
        choices=["rating", "fastest", "costLow", "costHigh", "newest", "distance"], required=False
    )
    lat = serializers.FloatField(
        required=False,
        min_value=-90,
        max_value=90,
        error_messages={k: "lat must be -90 to 90" for k in ("min_value", "max_value", "invalid")},
    )
    lng = serializers.FloatField(
        required=False,
        min_value=-180,
        max_value=180,
        error_messages={
            k: "lng must be -180 to 180" for k in ("min_value", "max_value", "invalid")
        },
    )
    radius_km = serializers.FloatField(required=False, min_value=1, max_value=50)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if ("lat" in attrs) != ("lng" in attrs):
            missing = "lat" if "lat" not in attrs else "lng"
            present = "lng" if missing == "lat" else "lat"
            raise serializers.ValidationError({present: "Send both lat and lng"})
        return attrs


class AdminListQuery(PageQuery):
    status = serializers.ChoiceField(choices=RestaurantStatus.values, required=False)


class AdminStatusInput(serializers.Serializer):
    status = serializers.ChoiceField(
        choices=RestaurantStatus.values, error_messages={"invalid_choice": "Invalid status"}
    )
    reason = serializers.CharField(max_length=500, required=False, allow_blank=True)
