"""Category and dish request validation (Node: category.validators.js, food.validators.js)."""

import re
from typing import Any

from rest_framework import serializers

from common.fields import ImageUrlField, PaiseField, QueryBoolean, UUIDRef
from common.validation import PageQuery

ICON = re.compile(r"^[a-z0-9_]{1,40}$")


class CategoryInput(serializers.Serializer):
    name = serializers.CharField(
        min_length=2,
        max_length=50,
        error_messages={
            k: "Name must be 2-50 characters"
            for k in ("min_length", "max_length", "blank", "required")
        },
    )
    description = serializers.CharField(max_length=300, required=False, allow_blank=True)
    icon = serializers.RegexField(
        ICON,
        required=False,
        error_messages={"invalid": "Icon must be a Material Symbols name, e.g. local_pizza"},
    )
    image_url = ImageUrlField()
    sort_order = serializers.IntegerField(min_value=0, max_value=10_000, required=False)
    is_active = serializers.BooleanField(required=False)


class Tags(serializers.ListField):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(
            child=serializers.CharField(min_length=1, max_length=30),
            max_length=10,
            required=False,
            **kwargs,
        )


class FoodInput(serializers.Serializer):
    name = serializers.CharField(
        min_length=2,
        max_length=100,
        error_messages={
            k: "Name must be 2-100 characters"
            for k in ("min_length", "max_length", "blank", "required")
        },
    )
    description = serializers.CharField(
        max_length=500, required=False, allow_blank=True, allow_null=True
    )
    category = UUIDRef(
        message="Choose a category", error_messages={"required": "Choose a category"}
    )
    price_paise = PaiseField(min_value=100)
    is_veg = serializers.BooleanField(
        error_messages={
            "required": "Mark the dish as veg or non-veg",
            "invalid": "Mark the dish as veg or non-veg",
        }
    )
    is_available = serializers.BooleanField(required=False)
    image_url = ImageUrlField()
    prep_time_minutes = serializers.IntegerField(
        min_value=1, max_value=180, required=False, allow_null=True
    )
    tags = Tags()

    def to_internal_value(self, data: Any) -> Any:
        value = super().to_internal_value(data)
        if "tags" in value:
            value["tags"] = [t.strip().lower() for t in value["tags"]]
        return value


class AvailabilityInput(serializers.Serializer):
    is_available = serializers.BooleanField(
        error_messages={
            "required": "isAvailable must be true or false",
            "invalid": "isAvailable must be true or false",
        }
    )


class FoodListQuery(PageQuery):
    category = UUIDRef(required=False)
    available = QueryBoolean()
    veg = QueryBoolean()


class AdminFoodListQuery(FoodListQuery):
    restaurant = UUIDRef(required=False)


class PublicFoodQuery(PageQuery):
    category = UUIDRef(required=False)
    veg = QueryBoolean()
