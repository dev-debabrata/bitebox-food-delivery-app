"""/newsletter: public sign-up from the site footer, rate limited (Node: newsletter.routes.js)."""

from typing import Any

from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.validators import validate_email
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema, extend_schema_field
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from common.api import ok
from common.permissions import PUBLIC
from common.schema import envelope, errors
from common.throttling import rate_limit
from common.validation import validated

from . import services

INVALID = "Invalid value"


@extend_schema_field(OpenApiTypes.EMAIL)
class EmailInput(serializers.Field):
    """A string, trimmed and lower-cased, at most 254 characters, that looks like an email."""

    default_error_messages = {"required": INVALID, "null": INVALID}

    def to_internal_value(self, data: Any) -> str:
        if not isinstance(data, str):
            raise serializers.ValidationError(INVALID)
        email = data.strip().lower()
        if len(email) > 254:
            raise serializers.ValidationError(INVALID)
        try:
            validate_email(email)
        except DjangoValidationError:
            raise serializers.ValidationError("Enter a valid email address") from None
        return email

    def to_representation(self, value: Any) -> Any:
        return value


class NewsletterSignupInput(serializers.Serializer):
    email = EmailInput()


class SubscriptionsView(APIView):
    permission_classes = PUBLIC
    throttle_classes = [
        rate_limit("NEWSLETTER_RATE_LIMIT", "Too many sign-up attempts. Please try again later.")
    ]

    @extend_schema(
        tags=["Newsletter"],
        request=NewsletterSignupInput,
        responses={200: envelope("NewsletterSubscription"), **errors(422, 429)},
    )
    def post(self, request: Request) -> Response:
        email = validated(NewsletterSignupInput, request.data)["email"]
        result = services.subscribe(email)
        message = "You're already subscribed" if result["alreadySubscribed"] else "Subscribed"
        return ok(result, message=message)
