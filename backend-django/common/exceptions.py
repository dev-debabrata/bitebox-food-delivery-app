"""
Every error leaves the API in the same envelope as the Node API
(backend/middleware/error.middleware.js):
`{ success: false, message, error: { code, details? } }`, with `Cache-Control: no-store`.
"""

import logging
from typing import Any

from django.conf import settings
from django.db import DatabaseError, OperationalError
from django.http import Http404, HttpRequest, JsonResponse
from rest_framework import exceptions as drf
from rest_framework.response import Response

from .api import ApiError, error_body

logger = logging.getLogger("bitebox.errors")

GENERIC_MESSAGE = "Something went wrong. Please try again later."


def _camel(name: str) -> str:
    """snake_case → camelCase, matching the renderer (postal_code → postalCode)."""
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def flatten_validation(detail: Any, prefix: str = "") -> list[dict[str, str]]:
    """
    DRF's nested validation errors → `[{field, message}]`, first message per field, with the
    same paths the Node API produced: `address.city`, `items[0].quantity`.
    """
    out: list[dict[str, str]] = []
    if isinstance(detail, dict):
        for key, value in detail.items():
            if key in ("non_field_errors", "__all__"):
                path = prefix
            elif isinstance(key, int):  # list items (DRF reports them keyed by index)
                path = f"{prefix}[{key}]"
            else:
                path = f"{prefix}.{_camel(str(key))}" if prefix else _camel(str(key))
            out.extend(flatten_validation(value, path))
    elif isinstance(detail, list):
        if detail and all(not isinstance(item, (dict, list)) for item in detail):
            out.append({"field": prefix, "message": str(detail[0])})
        else:
            for index, item in enumerate(detail):
                if item:  # DRF puts {} for list items without errors
                    out.extend(flatten_validation(item, f"{prefix}[{index}]"))
    else:
        out.append({"field": prefix, "message": str(detail)})
    return out


def _normalise(exc: Exception) -> ApiError | None:
    if isinstance(exc, ApiError):
        return exc
    if isinstance(exc, drf.ValidationError):
        return ApiError(
            422,
            "Validation failed",
            code="VALIDATION_ERROR",
            details=flatten_validation(exc.detail),
        )
    if isinstance(exc, drf.ParseError):
        return ApiError.bad_request("Malformed JSON body")
    if isinstance(exc, (drf.NotAuthenticated, drf.AuthenticationFailed)):
        return ApiError.unauthorized()
    if isinstance(exc, drf.PermissionDenied):
        detail = str(exc.detail)
        custom = detail and detail != str(drf.PermissionDenied.default_detail)
        return ApiError.forbidden(detail) if custom else ApiError.forbidden()
    if isinstance(exc, (Http404, drf.NotFound)):
        return ApiError.not_found()
    if isinstance(exc, drf.MethodNotAllowed):
        return ApiError(405, "Method not allowed", code="METHOD_NOT_ALLOWED")
    if isinstance(exc, drf.UnsupportedMediaType):
        return ApiError(415, "Unsupported content type", code="UNSUPPORTED_MEDIA_TYPE")
    if isinstance(exc, drf.Throttled):
        return ApiError(429, "Too many requests, please try again later.", code="RATE_LIMITED")
    if isinstance(exc, OperationalError):
        return ApiError(
            503, "Service temporarily unavailable, please retry", code="DATABASE_UNAVAILABLE"
        )
    return None


def exception_handler(exc: Exception, context: dict[str, Any]) -> Response:
    """REST_FRAMEWORK["EXCEPTION_HANDLER"]: handles every exception raised in a DRF view."""
    api_error = _normalise(exc)
    if api_error is None:
        logger.exception("Unhandled error", exc_info=exc)
        extra = {"debug": str(exc)} if settings.DEBUG else {}
        response = Response(
            error_body(GENERIC_MESSAGE, "INTERNAL_ERROR", None, **extra), status=500
        )
    else:
        if api_error.status_code >= 500 or isinstance(exc, DatabaseError):
            logger.error(api_error.message, exc_info=exc)
        response = Response(
            error_body(api_error.message, api_error.code or "ERROR", api_error.details),
            status=api_error.status_code,
        )
        wait = getattr(exc, "wait", None) or getattr(exc, "retry_after", None)
        if response.status_code == 429 and wait is not None:
            response["Retry-After"] = str(int(wait))
    response["Cache-Control"] = "no-store"
    return response


def route_not_found(request: HttpRequest, *args: Any, **kwargs: Any) -> JsonResponse:
    """Catch-all for unknown /api/ paths (works with DEBUG on, unlike handler404)."""
    message = f"Route not found: {request.method} {request.get_full_path()}"
    response = JsonResponse(
        error_body(message, "NOT_FOUND"), status=404, json_dumps_params={"separators": (",", ":")}
    )
    response["Cache-Control"] = "no-store"
    return response


def server_error(request: HttpRequest, *args: Any, **kwargs: Any) -> JsonResponse:
    """handler500: errors outside DRF views (middleware, URL resolution) still get the envelope."""
    response = JsonResponse(
        error_body(GENERIC_MESSAGE, "INTERNAL_ERROR"),
        status=500,
        json_dumps_params={"separators": (",", ":")},
    )
    response["Cache-Control"] = "no-store"
    return response
