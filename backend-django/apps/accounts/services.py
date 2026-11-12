"""
Sign-in and sessions, a port of the Node API's services/auth.service.js.

Refresh tokens rotate on every use. Each token belongs to a *family* (one sign-in); using a token
that was already rotated (outside a short race window) means it was copied, so the whole family
is revoked. Ending sessions bumps `token_version`, which also kills every access token at once.
"""

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.contrib.auth.hashers import check_password, make_password
from django.core.mail import send_mail
from django.db import transaction
from django.db.models import F
from django.utils import timezone
from django.utils.html import escape

from apps.rbac.roles import Role
from common.api import ApiError

from .models import RevokedReason, Session, User, UserStatus
from .serializers import user_json
from .tokens import hash_token, random_token, sign_access_token

logger = logging.getLogger("bitebox.auth")

ROTATION_GRACE = timedelta(seconds=15)
# Checked against when the email is unknown, so both cases take about as long.
_DUMMY_HASH = make_password("bitebox-timing-equaliser")


@dataclass(frozen=True)
class RequestMeta:
    ip: str | None
    user_agent: str


@dataclass(frozen=True)
class IssuedSession:
    user: dict[str, Any]
    access_token: str
    refresh_token: str


# Things other modules do when someone registers (welcome coins, referral attribution, notifying
# admins about new partners). Phase 9 registers them; each runs after commit and never fails
# sign-up.
RegistrationHook = Callable[[User, dict[str, Any], RequestMeta], None]
registration_hooks: list[RegistrationHook] = []


def _create_session(user: User, meta: RequestMeta, family: str | None = None) -> str:
    raw = random_token()
    Session.objects.create(
        user=user,
        token_hash=hash_token(raw),
        family=family or str(uuid.uuid4()),
        expires_at=timezone.now() + timedelta(days=settings.REFRESH_TOKEN_TTL_DAYS),
        user_agent=(meta.user_agent or "")[:512],
        ip=meta.ip,
    )
    return raw


def _issue(user: User, meta: RequestMeta, family: str | None = None) -> IssuedSession:
    refresh = _create_session(user, meta, family)
    return IssuedSession(
        user=user_json(user), access_token=sign_access_token(user), refresh_token=refresh
    )


def revoke_all_sessions(user: User, reason: str) -> None:
    Session.objects.filter(user=user, revoked_at__isnull=True).update(
        revoked_at=timezone.now(), revoked_reason=reason
    )


def end_sessions(user: User, reason: str, *, fields: tuple[str, ...] = ()) -> None:
    """
    Saves `fields` of `user` and signs them out everywhere: the token version goes up atomically
    (old access tokens fail) and every refresh session is revoked.
    """
    with transaction.atomic():
        user.token_version = F("token_version") + 1
        user.save(update_fields=[*fields, "token_version", "updated_at"])
        user.refresh_from_db(fields=["token_version"])
        revoke_all_sessions(user, reason)


def _phone_taken(phone: str, exclude: uuid.UUID | None = None) -> bool:
    qs = User.objects.filter(phone=phone)
    return (qs.exclude(pk=exclude) if exclude else qs).exists()


def register(data: dict[str, Any], meta: RequestMeta) -> IssuedSession:
    role = data.get("role") or Role.CUSTOMER
    email, phone = data["email"], data.get("phone") or None
    if User.objects.filter(email=email).exists():
        raise ApiError.conflict("An account with this email already exists")
    if phone and _phone_taken(phone):
        raise ApiError.conflict("An account with this phone number already exists")

    with transaction.atomic():
        user = User.objects.create_user(
            email, data["password"], data["name"], phone=phone, role=role
        )
        session = _issue(user, meta)
        for hook in registration_hooks:
            transaction.on_commit(_safe(hook, user, data, meta))
    logger.info("User registered", extra={"user_id": str(user.pk), "role": role})
    return session


def _safe(hook: RegistrationHook, *args: Any) -> Callable[[], None]:
    def run() -> None:
        try:
            hook(*args)
        except Exception:
            logger.exception(
                "Registration hook failed", extra={"hook": getattr(hook, "__name__", "?")}
            )

    return run


def login(data: dict[str, Any], meta: RequestMeta) -> IssuedSession:
    user = User.objects.filter(email=data["email"]).first()
    # Always check a hash, so unknown emails and wrong passwords take the same time.
    ok = (
        user.check_password(data["password"])
        if user
        else check_password(data["password"], _DUMMY_HASH)
    )
    if not user or not ok:
        raise ApiError.unauthorized("Invalid email or password")
    if user.status != UserStatus.ACTIVE:
        raise ApiError.forbidden("This account has been suspended")
    # Each panel has its own sign-in page: a customer can't use the admin login, and so on.
    portal = data.get("portal")
    if portal and user.role != portal:
        raise ApiError.forbidden("This account cannot sign in to this portal")

    user.last_login = timezone.now()
    user.save(update_fields=["last_login", "updated_at"])
    return _issue(user, meta)


def refresh(raw_token: str | None, meta: RequestMeta) -> IssuedSession:
    if not raw_token:
        raise ApiError.unauthorized("No session")
    token_hash = hash_token(raw_token)
    now = timezone.now()

    # Rotate atomically: only one request can revoke a live token.
    rotated = Session.objects.filter(
        token_hash=token_hash, revoked_at__isnull=True, expires_at__gt=now
    ).update(revoked_at=now, revoked_reason=RevokedReason.ROTATED)
    session = Session.objects.filter(token_hash=token_hash).select_related("user").first()
    if not rotated:
        if (
            session is None
            or session.revoked_reason != RevokedReason.ROTATED
            or session.revoked_at is None
        ):
            raise ApiError.unauthorized("Session expired, please sign in again")
        if now - session.revoked_at >= ROTATION_GRACE:
            # A rotated token came back: it was copied. Revoke the whole family.
            Session.objects.filter(family=session.family, revoked_at__isnull=True).update(
                revoked_at=now, revoked_reason=RevokedReason.REUSE
            )
            logger.warning(
                "Refresh token reuse detected; session family revoked",
                extra={"user_id": str(session.user_id)},
            )
            raise ApiError.unauthorized("Session expired, please sign in again")
        # Otherwise two tabs refreshed at the same moment: reissue for the same family.

    if session is None:  # unreachable: a rotated row exists
        raise ApiError.unauthorized("Session expired, please sign in again")
    user = session.user
    if user.status != UserStatus.ACTIVE:
        raise ApiError.unauthorized("Session expired, please sign in again")
    return _issue(user, meta, session.family)


def logout(raw_token: str | None) -> None:
    if raw_token:
        Session.objects.filter(token_hash=hash_token(raw_token), revoked_at__isnull=True).update(
            revoked_at=timezone.now(), revoked_reason=RevokedReason.LOGOUT
        )


def forgot_password(email: str) -> None:
    user = User.objects.filter(email=email, status=UserStatus.ACTIVE).first()
    if user is None:
        return  # same response either way: never reveal which emails exist
    token = random_token(32)
    minutes = settings.PASSWORD_RESET_TTL_MINUTES
    user.password_reset_token_hash = hash_token(token)
    user.password_reset_expires_at = timezone.now() + timedelta(minutes=minutes)
    user.save(
        update_fields=["password_reset_token_hash", "password_reset_expires_at", "updated_at"]
    )

    link = f"{settings.CLIENT_URLS[0]}/reset-password?token={token}"
    send_mail(
        subject="Reset your BiteBox password",
        message=(
            f"Hi {user.name},\n\nUse this link to reset your BiteBox password. It expires in "
            f"{minutes} minutes and can only be used once:\n\n{link}\n\nIf you did not request "
            "this, you can ignore this email."
        ),
        html_message=(
            f"<p>Hi {escape(user.name)},</p><p>Use the link below to reset your BiteBox password. "
            f"It expires in {minutes} minutes and can only be used once.</p>"
            f'<p><a href="{escape(link)}">Reset password</a></p>'
            "<p>If you did not request this, you can ignore this email.</p>"
        ),
        from_email=None,
        recipient_list=[user.email],
    )


def reset_password(token: str, new_password: str) -> None:
    password = make_password(new_password)
    with transaction.atomic():
        # Consume the token atomically so it works once.
        matched = User.objects.filter(
            password_reset_token_hash=hash_token(token),
            password_reset_expires_at__gt=timezone.now(),
        )
        user = matched.select_for_update().first()
        if user is None:
            raise ApiError.bad_request("This reset link is invalid or has expired")
        matched.update(
            password=password,
            password_reset_token_hash=None,
            password_reset_expires_at=None,
            token_version=F("token_version") + 1,
            updated_at=timezone.now(),
        )
        revoke_all_sessions(user, RevokedReason.PASSWORD_CHANGE)


def change_password(user: User, current: str, new: str) -> None:
    if not user.check_password(current):
        raise ApiError.bad_request("Current password is incorrect")
    user.set_password(new)
    end_sessions(user, RevokedReason.PASSWORD_CHANGE, fields=("password",))


def update_profile(user: User, data: dict[str, Any]) -> User:
    fields: list[str] = []
    if "name" in data:
        user.name = data["name"]
        fields.append("name")
    if "phone" in data:
        phone = data["phone"] or None
        if phone and _phone_taken(phone, exclude=user.pk):
            raise ApiError.conflict("An account with this phone number already exists")
        user.phone = phone
        fields.append("phone")
    if fields:
        user.save(update_fields=[*fields, "updated_at"])
    return user
