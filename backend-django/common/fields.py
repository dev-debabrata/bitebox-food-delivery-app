"""Serializer fields shared by the API, matching the Node API's common.validators.js."""

import re
from typing import Any

from rest_framework import serializers
from rest_framework.fields import empty

HTTP_URL = re.compile(r"^https?://[^\s\"'()\\<>]{1,490}$", re.IGNORECASE)


class PaiseField(serializers.IntegerField):
    """A whole number of paise in [min, max]; fractions are refused (no rounding money)."""

    def __init__(self, *, min_value: int = 0, max_value: int = 10_000_000, **kwargs: Any) -> None:
        self.money_range = (min_value, max_value)
        super().__init__(**kwargs)

    def to_internal_value(self, data: Any) -> int:
        lo, hi = self.money_range
        message = f"{self.field_name} must be a whole number of paise between {lo} and {hi}"
        if isinstance(data, bool) or (isinstance(data, float) and not data.is_integer()):
            raise serializers.ValidationError(message)
        try:
            value = int(super().to_internal_value(data))
        except serializers.ValidationError:
            raise serializers.ValidationError(message) from None
        if not lo <= value <= hi:
            raise serializers.ValidationError(message)
        return value


class ImageUrlField(serializers.CharField):
    """Optional http(s) image URL; "" or null clear it."""

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("required", False)
        kwargs.setdefault("allow_blank", True)
        kwargs.setdefault("allow_null", True)
        super().__init__(**kwargs)

    def to_internal_value(self, data: Any) -> str:
        value = str(super().to_internal_value(data) or "").strip()
        if value and not HTTP_URL.match(value):
            raise serializers.ValidationError("Image must be an http(s) URL")
        return value


class QueryBoolean(serializers.BooleanField):
    """
    `?veg=true|false` (Node: booleanQuery). A missing parameter stays missing: DRF would
    otherwise read an absent boolean in form/query data as false (like an unticked checkbox).
    """

    default_empty_html = empty

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("required", False)
        super().__init__(**kwargs)
        self.error_messages["invalid"] = "must be true or false"

    def bind(self, field_name: str, parent: Any) -> None:
        super().bind(field_name, parent)
        self.error_messages["invalid"] = f"{field_name} must be true or false"


class UUIDRef(serializers.UUIDField):
    """An id in a body or query (Node: isMongoId), with a custom message."""

    def __init__(self, message: str = "Invalid id", **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.error_messages["invalid"] = message
