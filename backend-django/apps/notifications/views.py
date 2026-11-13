"""
The inbox (/notifications), Web Push (/push) and admin promotions (/admin/push), as in the Node
API, plus channel preferences, FCM device tokens and the admin delivery log.
"""

import re
from typing import Any

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from apps.audit.services import audited
from apps.rbac.roles import Permission
from common.api import ok
from common.pagination import Page
from common.permissions import PUBLIC, IsSignedIn, permission_required
from common.schema import envelope, errors
from common.throttling import rate_limit
from common.validation import PageQuery, parse_id, validated

from . import services
from .content import CATEGORIES
from .models import Channel, DeliveryStatus, DevicePlatform

SITE_PATH = re.compile(r"^/(?!/)[A-Za-z0-9\-._~/?#\[\]@!$&'()*+,;=%]{0,199}$")
SIGNED_IN = [IsSignedIn]
CHANNEL_PREFS = envelope("ChannelPreferences")
PUSH_PREFS = envelope("PushPreferences")


# ---------------------------------------------------------------------------
# Inbox
# ---------------------------------------------------------------------------
class InboxQuery(PageQuery):
    unread = serializers.BooleanField(required=False)


class InboxView(APIView):
    permission_classes = SIGNED_IN

    @extend_schema(
        tags=["Notifications"],
        operation_id="notifications_list",
        parameters=[InboxQuery],
        responses={200: envelope("Inbox"), **errors(401, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(InboxQuery, request.query_params)
        page = Page.from_query(query)
        return ok(services.inbox(current_user(request), page, bool(query.get("unread"))))

    @extend_schema(tags=["Notifications"], responses={200: envelope("InboxCleared")})
    def delete(self, request: Request) -> Response:
        return ok(services.clear_all(current_user(request)), message="Notifications cleared")


class ReadAllView(APIView):
    permission_classes = SIGNED_IN

    @extend_schema(tags=["Notifications"], request=None, responses={200: envelope("ReadAll")})
    def post(self, request: Request) -> Response:
        return ok(services.mark_all_read(current_user(request)), message="All caught up")


class ReadView(APIView):
    permission_classes = SIGNED_IN

    @extend_schema(
        tags=["Notifications"],
        request=None,
        responses={200: envelope("NotificationRead"), **errors(401, 404, 422)},
    )
    def patch(self, request: Request, id: str) -> Response:
        return ok({"notification": services.mark_read(current_user(request), parse_id(id))})


# ---------------------------------------------------------------------------
# Preferences
# ---------------------------------------------------------------------------
class StrictBoolean(serializers.BooleanField):
    """Only JSON true/false (Node: isBoolean({ strict: true })), never "yes" or 1."""

    def to_internal_value(self, data: Any) -> bool:
        if not isinstance(data, bool):
            self.fail("invalid")
        return data


def _switch(category: str) -> StrictBoolean:
    return StrictBoolean(
        required=False, error_messages={"invalid": f"{category} must be true or false"}
    )


def _switches(name: str) -> serializers.Serializer:
    fields = {c: _switch(c) for c in CATEGORIES}
    return type(name, (serializers.Serializer,), fields)(required=False)


class PushPreferencesInput(serializers.Serializer):
    orders = _switch("orders")
    account = _switch("account")
    promotions = _switch("promotions")


class ChannelPreferencesInput(serializers.Serializer):
    push = _switches("PushSwitches")
    email = _switches("EmailSwitches")
    sms = _switches("SmsSwitches")


class ChannelPreferencesView(APIView):
    """Every channel's switches per category (push, email, SMS)."""

    permission_classes = SIGNED_IN

    @extend_schema(tags=["Notifications"], responses={200: CHANNEL_PREFS})
    def get(self, request: Request) -> Response:
        return ok(services.channel_preferences(current_user(request)))

    @extend_schema(
        tags=["Notifications"],
        request=ChannelPreferencesInput,
        responses={200: CHANNEL_PREFS, **errors(401, 422)},
    )
    def put(self, request: Request) -> Response:
        data = validated(ChannelPreferencesInput, request.data)
        prefs = services.update_channel_preferences(current_user(request), data)
        return ok(prefs, message="Notification preferences saved")


# ---------------------------------------------------------------------------
# Web Push
# ---------------------------------------------------------------------------
class PublicKeyView(APIView):
    permission_classes = PUBLIC
    authentication_classes: list[Any] = []

    @extend_schema(tags=["Push"], responses={200: envelope("PushConfig")})
    def get(self, request: Request) -> Response:
        return ok(services.public_config())


B64URL_KEY = r"^[A-Za-z0-9_-]{%d,%d}={0,2}$"


class KeysInput(serializers.Serializer):
    p256dh = serializers.RegexField(
        B64URL_KEY % (80, 100),
        error_messages=dict.fromkeys(("invalid", "required"), "Invalid subscription key"),
    )
    auth = serializers.RegexField(
        B64URL_KEY % (16, 32),
        error_messages=dict.fromkeys(("invalid", "required"), "Invalid subscription key"),
    )


def _endpoint() -> serializers.URLField:
    return serializers.URLField(
        min_length=20,
        max_length=1000,
        error_messages={
            "required": "Endpoint is required",
            "invalid": "Endpoint must be an https URL",
            "min_length": "Invalid endpoint",
            "max_length": "Invalid endpoint",
        },
    )


class SubscribeInput(serializers.Serializer):
    endpoint = _endpoint()
    keys = KeysInput()
    expiration_time = serializers.IntegerField(
        required=False,
        allow_null=True,
        min_value=0,
        error_messages={"invalid": "Invalid expiration time"},
    )


class UnsubscribeInput(serializers.Serializer):
    endpoint = _endpoint()


class SubscriptionsView(APIView):
    permission_classes = SIGNED_IN

    def get_throttles(self) -> list[Any]:
        if self.request.method == "POST":
            return [rate_limit("PUSH_RATE_LIMIT", "Too many attempts. Please try again later.")()]
        return []

    @extend_schema(
        tags=["Push"],
        request=SubscribeInput,
        responses={201: envelope("PushSubscribed"), **errors(401, 422, 429, 503)},
    )
    def post(self, request: Request) -> Response:
        data = validated(SubscribeInput, request.data)
        result = services.subscribe(
            current_user(request), data, request.headers.get("User-Agent", "")
        )
        return ok(result, message="Push notifications are on for this device", status=201)

    @extend_schema(
        tags=["Push"],
        request=UnsubscribeInput,
        responses={200: envelope("PushUnsubscribed"), **errors(401, 422)},
    )
    def delete(self, request: Request) -> Response:
        data = validated(UnsubscribeInput, request.data)
        result = services.unsubscribe(current_user(request), data["endpoint"])
        return ok(result, message="Push notifications are off for this device")


class PushPreferencesView(APIView):
    permission_classes = SIGNED_IN

    @extend_schema(tags=["Push"], responses={200: PUSH_PREFS})
    def get(self, request: Request) -> Response:
        return ok(services.push_preferences(current_user(request)))

    @extend_schema(
        tags=["Push"],
        request=PushPreferencesInput,
        responses={200: PUSH_PREFS, **errors(401, 422)},
    )
    def put(self, request: Request) -> Response:
        data = validated(PushPreferencesInput, request.data)
        prefs = services.update_push_preferences(current_user(request), data)
        return ok(prefs, message="Notification preferences saved")


class DeviceInput(serializers.Serializer):
    token = serializers.CharField(min_length=20, max_length=500)
    platform = serializers.ChoiceField(choices=DevicePlatform.values)


class DeviceRemoveInput(serializers.Serializer):
    token = serializers.CharField(min_length=20, max_length=500)


class DevicesView(APIView):
    """FCM registration tokens of the native apps (for when they exist)."""

    permission_classes = SIGNED_IN

    @extend_schema(
        tags=["Push"], request=DeviceInput, responses={201: envelope("DeviceRegistered")}
    )
    def post(self, request: Request) -> Response:
        data = validated(DeviceInput, request.data)
        result = services.register_device(current_user(request), data["token"], data["platform"])
        return ok(result, message="Device registered", status=201)

    @extend_schema(
        tags=["Push"], request=DeviceRemoveInput, responses={200: envelope("DeviceRemoved")}
    )
    def delete(self, request: Request) -> Response:
        data = validated(DeviceRemoveInput, request.data)
        return ok(services.unregister_device(current_user(request), data["token"]))


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
class PromotionInput(serializers.Serializer):
    title = serializers.CharField(
        min_length=3,
        max_length=60,
        error_messages=dict.fromkeys(
            ("required", "blank", "min_length", "max_length"), "Title must be 3–60 characters"
        ),
    )
    body = serializers.CharField(
        min_length=3,
        max_length=160,
        error_messages=dict.fromkeys(
            ("required", "blank", "min_length", "max_length"), "Message must be 3–160 characters"
        ),
    )
    link = serializers.RegexField(
        SITE_PATH,
        required=False,
        allow_blank=True,
        error_messages={"invalid": "Link must be a BiteBox page such as /restaurants"},
    )


class PromotionView(APIView):
    permission_classes = [permission_required(Permission.PROMOTIONS_SEND)]

    def get_throttles(self) -> list[Any]:
        return [
            rate_limit(
                "PROMOTION_RATE_LIMIT", "Too many promotions sent. Please try again later."
            )()
        ]

    @extend_schema(
        tags=["Admin: push"],
        request=PromotionInput,
        responses={200: envelope("PromotionSent"), **errors(401, 403, 422, 429, 503)},
    )
    @audited(
        "push.promotion", "promotion", lambda req: f'Pushed promotion "{req.data.get("title", "")}"'
    )
    def post(self, request: Request) -> Response:
        data = validated(PromotionInput, request.data)
        result = services.send_promotion(data["title"], data["body"], data.get("link") or "")
        return ok(result, message="Promotion is being sent")


class DeliveryQuery(PageQuery):
    status = serializers.ChoiceField(choices=DeliveryStatus.values, required=False)
    channel = serializers.ChoiceField(choices=Channel.values, required=False)


class AdminDeliveriesView(APIView):
    """The delivery log: what went out on each channel, failures and dead letters."""

    permission_classes = [permission_required(Permission.OPERATIONS_VIEW)]

    @extend_schema(
        tags=["Admin: notifications"],
        parameters=[DeliveryQuery],
        responses={200: envelope("DeliveryLog"), **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(DeliveryQuery, request.query_params)
        return ok(services.admin_deliveries(query, Page.from_query(query)))


class AdminDeliveryRetryView(APIView):
    permission_classes = [permission_required(Permission.OPERATIONS_VIEW)]

    @extend_schema(
        tags=["Admin: notifications"],
        request=None,
        parameters=[OpenApiParameter("id", str, OpenApiParameter.PATH)],
        responses={200: envelope("DeliveryRetried"), **errors(401, 403, 404, 409, 422)},
    )
    @audited("notification.retry", "notification_delivery", lambda req: "Retried a notification")
    def post(self, request: Request, id: str) -> Response:
        return ok(services.admin_retry(parse_id(id)), message="Sending again")
