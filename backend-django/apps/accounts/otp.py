"""
One-time codes by SMS (Node: services/otp.service.js): sign in with a phone number, or confirm a
signed-in person's number.

- 6 digits from `secrets`; only an HMAC (keyed with SECRET_KEY) is stored.
- A code lives OTP_TTL_SECONDS and allows OTP_MAX_ATTEMPTS tries; a new one can be asked for after
  OTP_RESEND_SECONDS, at most OTP_PER_PHONE_PER_HOUR per number and OTP_PER_IP_PER_HOUR per IP.
- Sign-in requests get the same answer whether or not the number has an account (a code is only
  sent when it does), so the endpoint cannot be used to find out who is registered.
"""

import hashlib
import hmac
import logging
import re
import secrets
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.db.models import F
from django.utils import timezone

from apps.notifications.senders import deliver_sms, sms_enabled
from common.api import ApiError

from .models import OtpChallenge, OtpPurpose, User, UserStatus

logger = logging.getLogger("bitebox.auth")


def _hash(phone: str, code: str) -> str:
    return hmac.new(
        settings.SECRET_KEY.encode(), f"{phone}:{code}".encode(), hashlib.sha256
    ).hexdigest()


def _limit(message: str) -> ApiError:
    return ApiError(429, message, code="OTP_RATE_LIMITED")


def send_code(phone: str, purpose: str, ip: str | None, send: bool) -> dict[str, Any]:
    """Creates a challenge (always) and texts the code when `send` (e.g. the number has an
    account, for sign-in)."""
    if not sms_enabled():
        raise ApiError(
            503,
            "We can't send text messages right now. Please try again later",
            code="SMS_UNAVAILABLE",
        )
    now = timezone.now()
    recent = OtpChallenge.objects.filter(phone=phone, purpose=purpose)
    last = recent.order_by("-created_at").first()
    if last and (wait := settings.OTP_RESEND_SECONDS - (now - last.created_at).total_seconds()) > 0:
        raise _limit(f"Wait {int(wait) + 1} seconds before asking for a new code")
    hour_ago = now - timedelta(hours=1)
    if recent.filter(created_at__gte=hour_ago).count() >= settings.OTP_PER_PHONE_PER_HOUR:
        raise _limit("Too many codes for this number. Try again in an hour")
    if (
        ip
        and OtpChallenge.objects.filter(ip=ip, created_at__gte=hour_ago).count()
        >= settings.OTP_PER_IP_PER_HOUR
    ):
        raise _limit("Too many codes requested. Try again in an hour")

    code = f"{secrets.randbelow(10**6):06d}"
    OtpChallenge.objects.create(
        purpose=purpose,
        phone=phone,
        code_hash=_hash(phone, code),
        expires_at=now + timedelta(seconds=settings.OTP_TTL_SECONDS),
        ip=ip,
    )
    if send:
        minutes = settings.OTP_TTL_SECONDS // 60
        deliver_sms(
            phone,
            f"{code} is your BiteBox code. It expires in {minutes} minutes. Never share it.",
            settings.MSG91_OTP_TEMPLATE_ID or None,
        )
    return {
        "resendInSeconds": settings.OTP_RESEND_SECONDS,
        "expiresInSeconds": settings.OTP_TTL_SECONDS,
    }


def check_code(phone: str, purpose: str, code: str) -> None:
    """Uses up the latest live code for this number, or raises 400/429. Each try counts."""
    challenge = (
        OtpChallenge.objects.filter(
            phone=phone, purpose=purpose, consumed_at__isnull=True, expires_at__gt=timezone.now()
        )
        .order_by("-created_at")
        .first()
    )
    if challenge is None:
        raise ApiError.bad_request("This code has expired. Ask for a new one")
    if challenge.attempts >= settings.OTP_MAX_ATTEMPTS:
        raise ApiError(429, "Too many wrong codes. Ask for a new one", code="OTP_LOCKED")
    OtpChallenge.objects.filter(pk=challenge.pk).update(attempts=F("attempts") + 1)
    if not hmac.compare_digest(challenge.code_hash, _hash(phone, code)):
        left = settings.OTP_MAX_ATTEMPTS - challenge.attempts - 1
        raise ApiError.bad_request(
            f"That code is not right. {left} {'try' if left == 1 else 'tries'} left"
            if left
            else "That code is not right. Ask for a new one"
        )
    # Exactly once, even if two requests carry the right code at the same moment.
    if not OtpChallenge.objects.filter(pk=challenge.pk, consumed_at__isnull=True).update(
        consumed_at=timezone.now()
    ):
        raise ApiError.bad_request("This code has already been used. Ask for a new one")


def phone_forms(phone: str) -> set[str]:
    """The ways one Indian mobile number may be stored: as typed, 10 digits, +91 and 91 prefixed."""
    digits = re.sub(r"\D", "", phone)
    forms = {phone, digits, f"+{digits}"}
    if len(digits) >= 10:
        last10 = digits[-10:]
        forms |= {last10, f"+91{last10}", f"91{last10}"}
    return forms


def login_user(phone: str) -> User | None:
    return User.objects.filter(phone__in=phone_forms(phone), status=UserStatus.ACTIVE).first()


def request_login_code(phone: str, ip: str | None) -> dict[str, Any]:
    return send_code(phone, OtpPurpose.LOGIN, ip, login_user(phone) is not None)
