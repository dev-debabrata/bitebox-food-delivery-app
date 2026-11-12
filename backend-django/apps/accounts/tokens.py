"""
Access tokens (JWT, HS256, short-lived, kept in browser memory) and refresh tokens (random, stored
only as a SHA-256 hash). Same claims as the Node API (utils/tokens.js): sub, role, tv, iss, aud.
"""

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import jwt
from django.conf import settings

if TYPE_CHECKING:
    from .models import User


def random_token(nbytes: int = 48) -> str:
    return secrets.token_urlsafe(nbytes)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _secret() -> str:
    secret = settings.JWT_SECRET
    if len(secret) < 32:
        raise RuntimeError("JWT_SECRET must be set (32+ characters)")
    return secret


def sign_access_token(user: "User") -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": str(user.pk),
        "role": user.role,
        "tv": user.token_version,
        "iat": now,
        "exp": now + timedelta(seconds=settings.JWT_ACCESS_TTL_SECONDS),
        "iss": settings.JWT_ISSUER,
        "aud": settings.JWT_AUDIENCE,
    }
    return jwt.encode(payload, _secret(), algorithm="HS256")


@dataclass(frozen=True)
class AccessClaims:
    user_id: str
    token_version: int
    expires_at: int = 0  # Unix seconds (the socket closes when the token it opened with expires)


class TokenExpired(Exception):
    pass


class TokenInvalid(Exception):
    pass


def verify_access_token(token: str) -> AccessClaims:
    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            _secret(),
            algorithms=["HS256"],  # never "none" or another algorithm chosen by the token
            issuer=settings.JWT_ISSUER,
            audience=settings.JWT_AUDIENCE,
            options={"require": ["exp", "sub", "iss", "aud"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise TokenExpired from exc
    except jwt.PyJWTError as exc:
        raise TokenInvalid from exc
    tv = payload.get("tv", 0)
    if not isinstance(tv, int):
        raise TokenInvalid
    return AccessClaims(
        user_id=str(payload["sub"]), token_version=tv, expires_at=int(payload["exp"])
    )
