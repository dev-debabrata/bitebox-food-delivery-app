"""
The response contract shared with the Angular app (same as the Node API):

    success: { "success": true,  "message": "...", "data": ... }
    error:   { "success": false, "message": "...", "error": { "code": "...", "details": [...] } }

Views return `ok(data)`; client-visible failures raise `ApiError`. Anything else becomes a
generic 500 in `common.exceptions`.
"""

from typing import Any

from rest_framework import status as http
from rest_framework.response import Response


class ApiError(Exception):
    """An error the client may see. `details` is a list of `{"field", "message"}`."""

    def __init__(
        self,
        status_code: int,
        message: str,
        *,
        code: str | None = None,
        details: list[dict[str, str]] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.code = code
        self.details = details

    @classmethod
    def bad_request(
        cls, message: str = "Bad request", details: list[dict[str, str]] | None = None
    ) -> "ApiError":
        return cls(http.HTTP_400_BAD_REQUEST, message, code="BAD_REQUEST", details=details)

    @classmethod
    def unauthorized(cls, message: str = "Authentication required") -> "ApiError":
        return cls(http.HTTP_401_UNAUTHORIZED, message, code="UNAUTHORIZED")

    @classmethod
    def forbidden(
        cls, message: str = "You do not have permission to perform this action"
    ) -> "ApiError":
        return cls(http.HTTP_403_FORBIDDEN, message, code="FORBIDDEN")

    @classmethod
    def not_found(cls, message: str = "Resource not found") -> "ApiError":
        return cls(http.HTTP_404_NOT_FOUND, message, code="NOT_FOUND")

    @classmethod
    def conflict(
        cls, message: str = "Resource already exists", code: str = "CONFLICT"
    ) -> "ApiError":
        return cls(http.HTTP_409_CONFLICT, message, code=code)


def ok(data: Any = None, message: str = "OK", status: int = http.HTTP_200_OK) -> Response:
    """A success response in the envelope."""
    return Response({"success": True, "message": message, "data": data}, status=status)


def error_body(
    message: str, code: str, details: list[dict[str, str]] | None = None, **extra: Any
) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, **extra}
    if details:
        error["details"] = details
    return {"success": False, "message": message, "error": error}
