"""OpenAPI helpers: every response is wrapped in the `{ success, message, data }` envelope."""

from typing import Any

from drf_spectacular.utils import OpenApiResponse, inline_serializer
from rest_framework import serializers

ERROR = inline_serializer(
    name="ErrorEnvelope",
    fields={
        "success": serializers.BooleanField(default=False),
        "message": serializers.CharField(),
        "error": inline_serializer(
            name="ErrorBody",
            fields={
                "code": serializers.CharField(),
                "details": inline_serializer(
                    name="FieldError",
                    fields={"field": serializers.CharField(), "message": serializers.CharField()},
                    many=True,
                    required=False,
                ),
            },
        ),
    },
)


def envelope(name: str, data: Any = None) -> Any:
    """A success envelope whose `data` is `data` (a serializer instance/class, or None)."""
    return inline_serializer(
        name=name,
        fields={
            "success": serializers.BooleanField(default=True),
            "message": serializers.CharField(),
            "data": data if data is not None else serializers.JSONField(allow_null=True),
        },
    )


def errors(*codes: int) -> dict[int, OpenApiResponse]:
    return {code: OpenApiResponse(ERROR) for code in codes}
