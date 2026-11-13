"""/api/v1/auth/* (Node: routes/auth.routes.js, controllers/auth.controller.js)."""

from typing import Any

from django.conf import settings
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.notifications.senders import sms_enabled
from common.api import ApiError, ok
from common.permissions import PUBLIC, IsSignedIn
from common.schema import envelope, errors
from common.throttling import rate_limit
from common.validation import validated

from . import otp, services
from .authentication import current_user
from .serializers import (
    ChangePasswordInput,
    EmailVerifyInput,
    ForgotPasswordInput,
    LoginInput,
    OtpCodeInput,
    OtpLoginInput,
    OtpRequestInput,
    RegisterInput,
    ResetPasswordInput,
    SignupCodeInput,
    UpdateProfileInput,
    UserOut,
    user_json,
)

AuthLimit = rate_limit("AUTH_RATE_LIMIT", "Too many attempts. Please try again in a few minutes.")
SensitiveLimit = rate_limit(
    "SENSITIVE_RATE_LIMIT", "Too many password reset requests. Please try again later."
)

SESSION = envelope(
    "Session",
    inline_serializer(
        name="SessionData", fields={"user": UserOut(), "access_token": serializers.CharField()}
    ),
)
USER = envelope("UserResponse", inline_serializer(name="UserData", fields={"user": UserOut()}))
EMPTY = envelope("Empty")
CODE_SENT = envelope(
    "CodeSent",
    inline_serializer(
        name="CodeSentData",
        fields={
            "resend_in_seconds": serializers.IntegerField(),
            "expires_in_seconds": serializers.IntegerField(),
        },
    ),
)


def _meta(request: Request) -> services.RequestMeta:
    ip = request.META.get("REMOTE_ADDR") or None
    return services.RequestMeta(ip=ip, user_agent=request.META.get("HTTP_USER_AGENT", ""))


def _cookie_options() -> dict[str, Any]:
    return {
        "path": settings.REFRESH_COOKIE_PATH,
        "httponly": True,
        "secure": settings.REFRESH_COOKIE_SECURE,
        "samesite": settings.REFRESH_COOKIE_SAMESITE,
    }


def _send_session(session: services.IssuedSession, message: str, status: int = 200) -> Response:
    response = ok(
        {"user": session.user, "access_token": session.access_token}, message=message, status=status
    )
    response.set_cookie(
        settings.REFRESH_COOKIE_NAME,
        session.refresh_token,
        max_age=settings.REFRESH_TOKEN_TTL_DAYS * 86_400,
        **_cookie_options(),
    )
    response["Cache-Control"] = "no-store"
    return response


def _clear_cookie(response: Response) -> Response:
    options = _cookie_options()
    response.delete_cookie(
        settings.REFRESH_COOKIE_NAME, path=options["path"], samesite=options["samesite"]
    )
    return response


def _require_trusted_origin(request: Request) -> None:
    """
    Cookie-authenticated endpoints (refresh, logout) need the web app's Origin (if any) and the
    `X-Requested-With: BiteBox` header, which a cross-site form or image can't send.
    """
    origin = request.META.get("HTTP_ORIGIN")
    if origin and origin not in settings.CLIENT_URLS:
        raise ApiError.forbidden("Untrusted origin")
    if request.META.get("HTTP_X_REQUESTED_WITH") != "BiteBox":
        raise ApiError.forbidden("Missing CSRF header")


def _refresh_cookie(request: Request) -> str | None:
    return request.COOKIES.get(settings.REFRESH_COOKIE_NAME)


class RegisterView(APIView):
    permission_classes = PUBLIC
    throttle_classes = [AuthLimit]

    @extend_schema(
        tags=["Auth"], request=RegisterInput, responses={201: SESSION, **errors(409, 422, 429)}
    )
    def post(self, request: Request) -> Response:
        data = validated(RegisterInput, request.data)
        return _send_session(
            services.register(data, _meta(request)), "Account created successfully", 201
        )


class LoginView(APIView):
    permission_classes = PUBLIC
    throttle_classes = [AuthLimit]

    @extend_schema(
        tags=["Auth"], request=LoginInput, responses={200: SESSION, **errors(401, 403, 422, 429)}
    )
    def post(self, request: Request) -> Response:
        data = validated(LoginInput, request.data)
        return _send_session(services.login(data, _meta(request)), "Signed in successfully")


class RefreshView(APIView):
    permission_classes = PUBLIC
    authentication_classes: list[Any] = []  # uses the refresh cookie, not a bearer token

    @extend_schema(
        tags=["Auth"],
        summary="Rotate the refresh cookie and get a new access token",
        description=(
            "Needs the `bb_refresh` cookie, the `X-Requested-With: BiteBox` header and a "
            "trusted Origin."
        ),
        request=None,
        responses={200: SESSION, **errors(401, 403)},
    )
    def post(self, request: Request) -> Response:
        _require_trusted_origin(request)
        try:
            session = services.refresh(_refresh_cookie(request), _meta(request))
        except ApiError as error:
            response = Response(
                {"success": False, "message": error.message, "error": {"code": error.code}},
                status=error.status_code,
            )
            response["Cache-Control"] = "no-store"
            return _clear_cookie(response)
        return _send_session(session, "Session refreshed")


class LogoutView(APIView):
    permission_classes = PUBLIC
    authentication_classes: list[Any] = []

    @extend_schema(tags=["Auth"], request=None, responses={200: EMPTY, **errors(403)})
    def post(self, request: Request) -> Response:
        _require_trusted_origin(request)
        services.logout(_refresh_cookie(request))
        return _clear_cookie(ok(message="Signed out successfully"))


class ForgotPasswordView(APIView):
    permission_classes = PUBLIC
    throttle_classes = [SensitiveLimit]

    @extend_schema(
        tags=["Auth"], request=ForgotPasswordInput, responses={200: EMPTY, **errors(422, 429)}
    )
    def post(self, request: Request) -> Response:
        services.forgot_password(validated(ForgotPasswordInput, request.data)["email"])
        return ok(message="If an account exists for this email, a reset link has been sent")


class ResetPasswordView(APIView):
    permission_classes = PUBLIC
    throttle_classes = [SensitiveLimit]

    @extend_schema(
        tags=["Auth"], request=ResetPasswordInput, responses={200: EMPTY, **errors(400, 422, 429)}
    )
    def post(self, request: Request) -> Response:
        data = validated(ResetPasswordInput, request.data)
        services.reset_password(data["token"], data["password"])
        return _clear_cookie(
            ok(message="Password has been reset. Please sign in with your new password")
        )


class MeView(APIView):
    permission_classes = [IsSignedIn]

    @extend_schema(tags=["Auth"], responses={200: USER, **errors(401)})
    def get(self, request: Request) -> Response:
        return ok({"user": user_json(current_user(request))})

    @extend_schema(
        tags=["Auth"], request=UpdateProfileInput, responses={200: USER, **errors(401, 409, 422)}
    )
    def patch(self, request: Request) -> Response:
        data = validated(UpdateProfileInput, request.data, partial=True)
        user = services.update_profile(current_user(request), data)
        return ok({"user": user_json(user)}, message="Profile updated")


class ChangePasswordView(APIView):
    permission_classes = [IsSignedIn]
    throttle_classes = [AuthLimit]

    @extend_schema(
        tags=["Auth"],
        request=ChangePasswordInput,
        responses={200: EMPTY, **errors(400, 401, 422, 429)},
    )
    def post(self, request: Request) -> Response:
        data = validated(ChangePasswordInput, request.data)
        services.change_password(
            current_user(request), data["current_password"], data["new_password"]
        )
        return _clear_cookie(ok(message="Password changed. Please sign in again"))


# --- phone codes and email verification ---------------------------------------------------------


class AuthMethodsView(APIView):
    """What the sign-in and profile pages may offer: SMS codes only when SMS is set up."""

    permission_classes = PUBLIC

    @extend_schema(
        tags=["Auth"],
        responses={
            200: envelope(
                "AuthMethodsResponse",
                inline_serializer("AuthMethods", {"phone": serializers.BooleanField()}),
            )
        },
    )
    def get(self, request: Request) -> Response:
        return ok({"phone": sms_enabled()}, message="Sign-in methods")


class SignupCodeView(APIView):
    permission_classes = PUBLIC
    throttle_classes = [AuthLimit]

    @extend_schema(
        tags=["Auth"],
        request=SignupCodeInput,
        responses={200: CODE_SENT, **errors(409, 422, 429, 503)},
    )
    def post(self, request: Request) -> Response:
        data = validated(SignupCodeInput, request.data)
        sent = services.request_signup_code(data["email"], data["phone"], _meta(request).ip)
        return ok(sent, message="We have sent a code to your phone")


class OtpRequestView(APIView):
    permission_classes = PUBLIC
    throttle_classes = [AuthLimit]

    @extend_schema(
        tags=["Auth"], request=OtpRequestInput, responses={200: CODE_SENT, **errors(422, 429, 503)}
    )
    def post(self, request: Request) -> Response:
        phone = validated(OtpRequestInput, request.data)["phone"]
        data = otp.request_login_code(phone, _meta(request).ip)
        # The same answer whether or not the number has an account.
        return ok(data, message="If this number has a BiteBox account, we have sent a code")


class OtpLoginView(APIView):
    permission_classes = PUBLIC
    throttle_classes = [AuthLimit]

    @extend_schema(
        tags=["Auth"],
        request=OtpLoginInput,
        responses={200: SESSION, **errors(400, 401, 403, 422, 429)},
    )
    def post(self, request: Request) -> Response:
        data = validated(OtpLoginInput, request.data)
        session = services.login_with_code(
            data["phone"], data["code"], data.get("portal"), _meta(request)
        )
        return _send_session(session, "Signed in successfully")


class PhoneVerificationView(APIView):
    permission_classes = [IsSignedIn]
    throttle_classes = [AuthLimit]

    @extend_schema(
        tags=["Auth"], request=None, responses={200: CODE_SENT, **errors(400, 401, 409, 429, 503)}
    )
    def post(self, request: Request) -> Response:
        data = services.request_phone_verification(current_user(request), _meta(request).ip)
        return ok(data, message="We have sent a code to your phone")


class PhoneVerifyView(APIView):
    permission_classes = [IsSignedIn]
    throttle_classes = [AuthLimit]

    @extend_schema(
        tags=["Auth"], request=OtpCodeInput, responses={200: USER, **errors(400, 401, 422, 429)}
    )
    def post(self, request: Request) -> Response:
        code = validated(OtpCodeInput, request.data)["code"]
        user = services.verify_phone(current_user(request), code)
        return ok({"user": user_json(user)}, message="Phone number verified")


class EmailVerificationView(APIView):
    permission_classes = [IsSignedIn]
    throttle_classes = [SensitiveLimit]

    @extend_schema(tags=["Auth"], request=None, responses={200: EMPTY, **errors(401, 409, 429)})
    def post(self, request: Request) -> Response:
        services.resend_email_verification(current_user(request))
        return ok(message="We have sent you a new link")


class EmailVerifyView(APIView):
    permission_classes = PUBLIC
    throttle_classes = [AuthLimit]

    @extend_schema(
        tags=["Auth"], request=EmailVerifyInput, responses={200: EMPTY, **errors(400, 422, 429)}
    )
    def post(self, request: Request) -> Response:
        services.verify_email(validated(EmailVerifyInput, request.data)["token"])
        return ok(message="Email verified")
