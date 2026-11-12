"""Request validation helpers that answer like the Node API's express-validator rules."""

import uuid
from typing import Any

from rest_framework import serializers

from .api import ApiError
from .pagination import MAX_LIMIT, Page


def parse_id(value: str, field: str = "id") -> uuid.UUID:
    """A path id → UUID, or 422 "Invalid id" (Node: mongoIdParam)."""
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        raise ApiError(
            422,
            "Validation failed",
            code="VALIDATION_ERROR",
            details=[{"field": field, "message": "Invalid id"}],
        ) from None


def validated(
    serializer_class: type[serializers.Serializer], data: Any, **kwargs: Any
) -> dict[str, Any]:
    """Validate (422 on failure) and return only the declared fields."""
    serializer = serializer_class(data=data, **kwargs)
    serializer.is_valid(raise_exception=True)
    return dict(serializer.validated_data)


class PageQuery(serializers.Serializer):
    """?page=&limit= : out-of-range values are a 422, like Node's paginationRules."""

    page = serializers.IntegerField(required=False, min_value=1, max_value=10_000)
    limit = serializers.IntegerField(required=False, min_value=1, max_value=MAX_LIMIT)
    search = serializers.CharField(
        required=False, allow_blank=True, max_length=100, trim_whitespace=True
    )

    def page_obj(self) -> Page:
        return Page.from_query(self.validated_data)
