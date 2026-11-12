"""
`Authorization: Bearer <access token>` for every DRF view (REST_FRAMEWORK settings).
Like the Node `authenticate` middleware, the user is re-loaded on every request, so a suspension,
password change or role change takes effect immediately (status and token_version checks).
"""

import uuid
from typing import Any

from drf_spectacular.extensions import OpenApiAuthenticationExtension
from rest_framework.authentication import BaseAuthentication
from rest_framework.request import Request

from common.api import ApiError

from .models import User, UserStatus
from .tokens import TokenExpired, TokenInvalid, verify_access_token


def user_for_token(token: str) -> User:
    """The active user a valid access token belongs to; raises ApiError 401 otherwise."""
    try:
        claims = verify_access_token(token)
    except TokenExpired:
        raise ApiError(401, "Access token expired", code="TOKEN_EXPIRED") from None
    except TokenInvalid:
        raise ApiError(401, "Invalid access token", code="UNAUTHORIZED") from None
    try:
        user = User.objects.get(pk=uuid.UUID(claims.user_id))
    except (ValueError, User.DoesNotExist):
        user = None
    if (
        user is None
        or user.status != UserStatus.ACTIVE
        or user.token_version != claims.token_version
    ):
        raise ApiError.unauthorized("Session is no longer valid")
    return user


def current_user(request: Request) -> User:
    """The signed-in user of a view protected by IsSignedIn / role / permission classes."""
    user = request.user
    if not isinstance(user, User):
        raise ApiError.unauthorized()
    return user


class BearerAuthentication(BaseAuthentication):
    def authenticate(self, request: Request) -> tuple[User, str] | None:
        header = request.META.get("HTTP_AUTHORIZATION", "")
        if not header:
            return None  # anonymous; protected views then answer 401
        scheme, _, token = header.partition(" ")
        if scheme != "Bearer" or not token:
            raise ApiError.unauthorized()
        return user_for_token(token.strip()), token

    def authenticate_header(self, request: Any) -> str:
        # Makes DRF answer 401 (not 403) when a protected view gets no credentials.
        return 'Bearer realm="api"'


class BearerAuthenticationScheme(OpenApiAuthenticationExtension):
    """Documents the bearer access token in the OpenAPI schema."""

    target_class = "apps.accounts.authentication.BearerAuthentication"
    name = "bearerAuth"

    def get_security_definition(self, auto_schema: Any) -> dict[str, str]:
        return {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}
