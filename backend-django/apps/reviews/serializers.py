"""
Review request validation, answering like the Node API's validators/review.validators.js:
the same fields, messages and 422 `details` paths.
"""

import uuid
from typing import Any

from rest_framework import serializers
from rest_framework.fields import empty

from apps.uploads.storage import is_uploaded_image_url
from common.fields import QueryBoolean, UUIDRef
from common.validation import PageQuery

from .models import (
    COMMENT_MAX,
    MAX_IMAGES,
    MODERATION_REASON_MAX,
    REPORT_NOTE_MAX,
    ReportReason,
    ReviewStatus,
    ReviewTarget,
)

SORTS = ["newest", "oldest", "highest", "lowest"]
STARS = "Choose a rating from 1 to 5 stars"
PHOTOS = f"Add up to {MAX_IMAGES} photos"


def choice_query(choices: list[str]) -> serializers.ChoiceField:
    keys = ("invalid_choice", "null", "blank")
    return serializers.ChoiceField(
        choices=choices, required=False, error_messages=dict.fromkeys(keys, "Invalid value")
    )


def rating_query() -> serializers.IntegerField:
    return serializers.IntegerField(
        required=False,
        min_value=1,
        max_value=5,
        error_messages=dict.fromkeys(
            ("invalid", "min_value", "max_value", "max_string_length"), "Invalid value"
        ),
    )


def stars(required: bool = False) -> serializers.IntegerField:
    """1–5 whole stars (Node: ratingOf); 3.5, "five", true and null are refused."""
    keys = ("required", "null", "invalid", "min_value", "max_value", "max_string_length")
    return serializers.IntegerField(
        required=required, min_value=1, max_value=5, error_messages=dict.fromkeys(keys, STARS)
    )


class TextField(serializers.CharField):
    """Optional trimmed text that must be a string (DRF would turn numbers into text)."""

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("required", False)
        kwargs.setdefault("allow_null", True)
        kwargs.setdefault("allow_blank", True)
        super().__init__(**kwargs)

    def to_internal_value(self, data: Any) -> str:
        if not isinstance(data, str):
            self.fail("invalid")
        return super().to_internal_value(data)


class PhotoUrl(serializers.CharField):
    """A photo uploaded through POST /uploads/review-images (Node: isUploadedImageUrl)."""

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("trim_whitespace", False)
        super().__init__(**kwargs)
        self.error_messages["blank"] = "Upload photos through BiteBox"

    def to_internal_value(self, data: Any) -> str:
        if not isinstance(data, str):
            self.fail("invalid")
        if not is_uploaded_image_url(data):
            raise serializers.ValidationError("Upload photos through BiteBox")
        return data


def comment_field() -> TextField:
    return TextField(
        max_length=COMMENT_MAX,
        error_messages={
            "invalid": "Comment must be text",
            "max_length": f"Keep the review under {COMMENT_MAX} characters",
        },
    )


def images_field() -> serializers.ListField:
    return serializers.ListField(
        child=PhotoUrl(error_messages={"invalid": "Invalid value"}),
        required=False,
        max_length=MAX_IMAGES,
        error_messages=dict.fromkeys(("not_a_list", "null", "max_length"), PHOTOS),
    )


class ReasonField(serializers.CharField):
    """Required, 3 to `MODERATION_REASON_MAX` characters once trimmed (Node: reasonBody)."""

    def __init__(self, missing: str, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.missing = missing
        self.error_messages.update(required=missing, null=missing)

    def run_validation(self, data: Any = empty) -> Any:
        is_empty, value = self.validate_empty_values(data)
        if is_empty:
            return value
        if not data:
            raise serializers.ValidationError(self.missing)
        if not isinstance(data, str):
            raise serializers.ValidationError("Invalid value")
        text = data.strip()
        if not 3 <= len(text) <= MODERATION_REASON_MAX:
            raise serializers.ValidationError(
                f"The reason must be 3 to {MODERATION_REASON_MAX} characters"
            )
        return text


def _without_nulls(attrs: dict[str, Any]) -> dict[str, Any]:
    """Node drops null optional values (`optional({ values: "null" })`)."""
    return {k: v for k, v in attrs.items() if v is not None}


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------
class PublicReviewQuery(PageQuery):
    rating = rating_query()
    sort = choice_query(SORTS)


class MyReviewsQuery(PageQuery):
    target = choice_query(ReviewTarget.values)
    sort = choice_query(SORTS)


class AdminReviewQuery(PageQuery):
    target = choice_query(ReviewTarget.values)
    status = choice_query(ReviewStatus.values)
    restaurant_id = UUIDRef(message="Invalid value", required=False)
    reported = QueryBoolean()
    rating = rating_query()


class DaysQuery(serializers.Serializer):
    days = serializers.IntegerField(
        required=False,
        min_value=1,
        max_value=365,
        error_messages=dict.fromkeys(
            ("invalid", "min_value", "max_value", "max_string_length"), "Invalid value"
        ),
    )


# ---------------------------------------------------------------------------
# Customer
# ---------------------------------------------------------------------------
class CreateReviewInput(serializers.Serializer):
    order_id = UUIDRef(
        message="Invalid order", error_messages=dict.fromkeys(("required", "null"), "Invalid order")
    )
    target = serializers.ChoiceField(
        choices=ReviewTarget.values,
        error_messages=dict.fromkeys(
            ("required", "null", "blank", "invalid_choice"),
            "Review the restaurant, a dish or the rider",
        ),
    )
    # Checked only for dish reviews (below), like Node's `.if(target === "food")`.
    food_item_id = serializers.JSONField(required=False)
    rating = stars(required=True)
    comment = comment_field()
    images = images_field()

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        attrs = _without_nulls(attrs)
        food_item_id = attrs.pop("food_item_id", None)
        if attrs["target"] == ReviewTarget.FOOD:
            try:
                attrs["food_item_id"] = uuid.UUID(str(food_item_id))
            except (TypeError, ValueError):
                raise serializers.ValidationError(
                    {"food_item_id": "Choose the dish you are reviewing"}
                ) from None
        if attrs["target"] == ReviewTarget.RIDER and "images" in self.initial_data:
            raise serializers.ValidationError({"images": "Delivery ratings don't take photos"})
        return attrs


class UpdateReviewInput(serializers.Serializer):
    rating = stars()
    comment = comment_field()
    images = images_field()

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if not any(k in self.initial_data for k in ("rating", "comment", "images")):
            raise serializers.ValidationError("Change the rating, the comment or the photos")
        return _without_nulls(attrs)


class OrderRatingInput(serializers.Serializer):
    """One "Rate your experience" submission: restaurant, food quality and delivery."""

    restaurant = stars()
    food = stars()
    rider = stars()
    comment = comment_field()
    images = images_field()

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        attrs = _without_nulls(attrs)
        if all(attrs.get(k) is None for k in ("restaurant", "food", "rider")):
            raise serializers.ValidationError("Rate at least one part of the order")
        if (attrs.get("comment") or attrs.get("images")) and attrs.get("restaurant") is None:
            raise serializers.ValidationError("Rate the restaurant to add a review or photos")
        return attrs


class ReportInput(serializers.Serializer):
    reason = serializers.ChoiceField(
        choices=ReportReason.values,
        error_messages=dict.fromkeys(
            ("required", "null", "blank", "invalid_choice"),
            f"Reason must be one of: {', '.join(ReportReason.values)}",
        ),
    )
    note = TextField(
        max_length=REPORT_NOTE_MAX,
        error_messages={
            "invalid": "Invalid value",
            "max_length": f"Keep the note under {REPORT_NOTE_MAX} characters",
        },
    )

    def to_internal_value(self, data: Any) -> Any:
        # Node: `optional({ values: "falsy" })`: 0, false, "" and null mean "no note".
        if isinstance(data, dict) and not data.get("note", True):
            data = {k: v for k, v in data.items() if k != "note"}
        return super().to_internal_value(data)


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
class ModerateInput(serializers.Serializer):
    action = serializers.ChoiceField(
        choices=["hide", "remove", "restore"],
        error_messages=dict.fromkeys(
            ("required", "null", "blank", "invalid_choice"),
            "Action must be hide, remove or restore",
        ),
    )
    reason = ReasonField(missing="Record why (customers see this)")


class DismissInput(serializers.Serializer):
    reason = ReasonField(missing="Give a reason")
