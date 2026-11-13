"""
Support ticket request validation, answering like the Node API's validators/support.validators.js:
the same fields, messages and 422 `details` paths.
"""

import re
import uuid
from typing import Any

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from common.validation import PageQuery

from .models import RequesterRole, TicketPriority, TicketStatus, TicketType

INVALID = "Invalid value"
ORDER_NUMBER = re.compile(r"^BB-\d{6}-[A-Z0-9]{6}$", re.IGNORECASE)
ACTIVE = "active"


@extend_schema_field(OpenApiTypes.STR)
class Text(serializers.Field):
    """
    A string, trimmed, `min`–`max` characters (Node: isString().trim().isLength()). A missing or
    non-string value gets `type_message`, a wrong length `length_message`.
    """

    def __init__(
        self,
        *,
        min_length: int = 0,
        max_length: int,
        type_message: str = INVALID,
        length_message: str = INVALID,
        **kwargs: Any,
    ) -> None:
        self.bounds = (min_length, max_length)
        self.length_message = length_message
        kwargs.setdefault("error_messages", {})
        kwargs["error_messages"].setdefault("required", type_message)
        kwargs["error_messages"].setdefault("null", type_message)
        kwargs["error_messages"]["invalid"] = type_message
        super().__init__(**kwargs)

    def to_internal_value(self, data: Any) -> str:
        if not isinstance(data, str):
            self.fail("invalid")
        value = data.strip()
        lo, hi = self.bounds
        if not lo <= len(value) <= hi:
            raise serializers.ValidationError(self.length_message)
        return value

    def to_representation(self, value: Any) -> Any:
        return value


def choice(choices: list[str], message: str = INVALID, **kwargs: Any) -> serializers.ChoiceField:
    keys = ("invalid_choice", "null", "blank", "required")
    return serializers.ChoiceField(
        choices=choices, error_messages=dict.fromkeys(keys, message), **kwargs
    )


def message_field() -> Text:
    return Text(
        min_length=2,
        max_length=2000,
        type_message="Write a message",
        length_message="Message must be 2-2000 characters",
    )


@extend_schema_field(OpenApiTypes.STR)
class OrderNumberField(serializers.Field):
    """Optional; falsy values ("", null, 0, false) count as not sent (Node: optional falsy)."""

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("required", False)
        kwargs.setdefault("allow_null", True)
        super().__init__(**kwargs)

    def validate_empty_values(self, data: Any) -> tuple[bool, Any]:
        if data is None or data in ("", 0, False):
            return True, None
        return super().validate_empty_values(data)

    def to_internal_value(self, data: Any) -> str:
        if not isinstance(data, str):
            raise serializers.ValidationError(INVALID)
        value = data.strip()
        if not ORDER_NUMBER.match(value):
            raise serializers.ValidationError("Order numbers look like BB-261105-ABC123")
        return value

    def to_representation(self, value: Any) -> Any:
        return value


@extend_schema_field(OpenApiTypes.BOOL)
class StrictBoolean(serializers.Field):
    """express-validator isBoolean(): true/false, "true"/"false", 0/1, "0"/"1"."""

    TRUE = (True, "true", "1", 1)
    FALSE = (False, "false", "0", 0)

    def to_internal_value(self, data: Any) -> bool:
        if isinstance(data, bool):
            return data
        if isinstance(data, (str, int)) and data in self.TRUE:
            return True
        if isinstance(data, (str, int)) and data in self.FALSE:
            return False
        raise serializers.ValidationError(INVALID)

    def to_representation(self, value: Any) -> Any:
        return value


@extend_schema_field(OpenApiTypes.UUID)
class AssigneeField(serializers.Field):
    """An admin id, or null / "" to unassign (both are sent values, not "missing")."""

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("required", False)
        kwargs.setdefault("allow_null", True)
        super().__init__(**kwargs)

    def to_internal_value(self, data: Any) -> uuid.UUID | None:
        if data == "":
            return None
        if isinstance(data, str) and re.fullmatch(r"[0-9a-fA-F-]{32,36}", data):
            try:
                return uuid.UUID(data)
            except ValueError:
                pass
        raise serializers.ValidationError("Invalid assignee")

    def to_representation(self, value: Any) -> Any:
        return str(value) if value else None


# ---------------------------------------------------------------------------
# Customers, restaurants and riders
# ---------------------------------------------------------------------------
class CreateTicketInput(serializers.Serializer):
    type = choice(TicketType.values, "Choose what this is about")
    subject = Text(
        min_length=5,
        max_length=120,
        type_message="Add a subject",
        length_message="Subject must be 5-120 characters",
    )
    message = message_field()
    order_number = OrderNumberField()


class MyTicketQuery(PageQuery):
    status = choice(["open", "closed"], required=False)


class ReplyInput(serializers.Serializer):
    body = message_field()


# ---------------------------------------------------------------------------
# Support staff
# ---------------------------------------------------------------------------
class StaffTicketQuery(PageQuery):
    status = choice([*TicketStatus.values, ACTIVE], required=False)
    priority = choice(TicketPriority.values, required=False)
    requester_role = choice(RequesterRole.values, required=False)
    type = choice(TicketType.values, required=False)
    assignee = choice(["me", "unassigned"], required=False)


class UpdateTicketInput(serializers.Serializer):
    status = choice(TicketStatus.values, required=False)
    priority = choice(TicketPriority.values, required=False)
    assignee_id = AssigneeField()
    note = Text(max_length=500, required=False)


class StaffMessageInput(serializers.Serializer):
    body = message_field()
    internal = StrictBoolean(required=False)


class EscalateInput(serializers.Serializer):
    note = Text(
        min_length=5,
        max_length=500,
        length_message="Explain what finance should check (5-500 characters)",
    )
