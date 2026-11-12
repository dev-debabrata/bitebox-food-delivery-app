"""Socket sign-in: the same token checks as HTTP (apps.accounts.authentication)."""

from typing import Any

from channels.db import database_sync_to_async

from apps.accounts.authentication import user_for_token
from apps.accounts.tokens import TokenExpired, TokenInvalid, verify_access_token
from common.api import ApiError


def session_for_token(token: str) -> tuple[Any, int] | None:
    """(user, token expiry in Unix seconds) for a valid access token of an active user, or None."""
    try:
        user = user_for_token(token)
        expires_at = verify_access_token(token).expires_at
    except (ApiError, TokenExpired, TokenInvalid):
        return None
    return user, expires_at


@database_sync_to_async
def _session(token: str) -> tuple[Any, int] | None:
    return session_for_token(token)


async def session_from_token(token: Any) -> tuple[Any, int] | None:
    if not isinstance(token, str) or not token:
        return None
    return await _session(token)


async def user_from_token(token: Any) -> Any | None:
    """The active user an access token belongs to (same checks as HTTP), or None."""
    session = await session_from_token(token)
    return session[0] if session else None
