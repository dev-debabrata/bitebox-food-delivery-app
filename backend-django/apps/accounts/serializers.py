"""
Request validation and the user JSON, matching the Node API (validators/auth.validators.js,
User.toJSON). Unknown fields are ignored, so a client can never set `role` or `status` itself.
"""

import re
from typing import Any

from rest_framework import serializers

from apps.rbac.roles import ADMIN_ROLES, ALL_ROLES, STAFF_ADMIN_ROLES, Role

from .models import User, UserStatus

SELF_REGISTER_ROLES = (Role.CUSTOMER, Role.RESTAURANT, Role.DELIVERY)
SELF_REGISTER_ROLE_VALUES = [r.value for r in SELF_REGISTER_ROLES]
PHONE = re.compile(r"^\+?[0-9]{10,15}$")
PHONE_MESSAGE = "Enter a valid phone number (10-15 digits)"


class EmailField(serializers.EmailField):
    """Trimmed and lower-cased (Node: normalizeEmail without the Gmail rewrites)."""

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("max_length", 254)
        kwargs.setdefault(
            "error_messages",
            {
                "required": "Email is required",
                "null": "Email is required",
                "blank": "Email is required",
                "invalid": "Enter a valid email address",
            },
        )
        super().__init__(**kwargs)

    def to_internal_value(self, data: Any) -> str:
        if not isinstance(data, str):
            self.fail("required")
        return str(super().to_internal_value(data)).lower()


class NewPasswordField(serializers.CharField):
    """8+ characters with a letter and a number, at most 72 bytes (bcrypt's limit in Node)."""

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("trim_whitespace", False)
        kwargs.setdefault(
            "error_messages",
            {
                "required": "Password is required",
                "null": "Password is required",
                "blank": "Password is required",
            },
        )
        super().__init__(**kwargs)

    def to_internal_value(self, data: Any) -> str:
        if not isinstance(data, str):
            self.fail("required")
        value = str(super().to_internal_value(data))
        if len(value) < 8:
            raise serializers.ValidationError("Password must be at least 8 characters")
        if len(value.encode()) > 72:
            raise serializers.ValidationError("Password is too long")
        if not re.search(r"[A-Za-z]", value):
            raise serializers.ValidationError("Password must contain a letter")
        if not re.search(r"[0-9]", value):
            raise serializers.ValidationError("Password must contain a number")
        return value


class NameField(serializers.CharField):
    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault(
            "error_messages",
            {
                "required": "Name is required",
                "null": "Name is required",
                "blank": "Name must be 2-80 characters",
            },
        )
        super().__init__(**kwargs)

    def to_internal_value(self, data: Any) -> str:
        if not isinstance(data, str):
            self.fail("required")
        value = str(super().to_internal_value(data))
        if not 2 <= len(value) <= 80:
            raise serializers.ValidationError("Name must be 2-80 characters")
        return value


class PhoneField(serializers.CharField):
    """Optional; an empty value means "no phone"."""

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("required", False)
        kwargs.setdefault("allow_blank", True)
        kwargs.setdefault("allow_null", True)
        super().__init__(**kwargs)

    def to_internal_value(self, data: Any) -> str:
        value = str(super().to_internal_value(data)).strip()
        if value and not PHONE.match(value):
            raise serializers.ValidationError(PHONE_MESSAGE)
        return value


def _choice(choices: tuple[Role, ...], message: str, **kwargs: Any) -> serializers.ChoiceField:
    return serializers.ChoiceField(
        choices=[r.value for r in choices], error_messages={"invalid_choice": message}, **kwargs
    )


class RegisterInput(serializers.Serializer):
    name = NameField()
    email = EmailField()
    phone = PhoneField()
    password = NewPasswordField()
    role = _choice(SELF_REGISTER_ROLES, "Invalid role", required=False)
    referral_code = serializers.RegexField(
        r"^[A-Za-z0-9-]{4,40}$",
        required=False,
        allow_blank=True,
        error_messages={"invalid": "Enter a valid referral code"},
    )


class LoginInput(serializers.Serializer):
    email = EmailField()
    password = serializers.CharField(
        min_length=1,
        max_length=128,
        trim_whitespace=False,
        error_messages={"required": "Password is required", "blank": "Password is required"},
    )
    portal = _choice(ALL_ROLES, "Invalid portal", required=False)


class ForgotPasswordInput(serializers.Serializer):
    email = EmailField()


class ResetPasswordInput(serializers.Serializer):
    token = serializers.CharField(
        min_length=20, max_length=200, error_messages={"required": "Reset token is required"}
    )
    password = NewPasswordField()


class ChangePasswordInput(serializers.Serializer):
    current_password = serializers.CharField(
        min_length=1,
        max_length=128,
        trim_whitespace=False,
        error_messages={
            "required": "Current password is required",
            "blank": "Current password is required",
        },
    )
    new_password = NewPasswordField()


class UpdateProfileInput(serializers.Serializer):
    name = NameField(required=False)
    phone = PhoneField()


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
class StaffCreateInput(serializers.Serializer):
    name = NameField()
    email = EmailField()
    phone = PhoneField()
    password = NewPasswordField()
    role = _choice(STAFF_ADMIN_ROLES, "Choose an operations, finance or support role")


class StaffUpdateInput(serializers.Serializer):
    name = NameField(required=False)
    phone = PhoneField()
    role = _choice(
        STAFF_ADMIN_ROLES, "Choose an operations, finance or support role", required=False
    )


class StatusInput(serializers.Serializer):
    status = serializers.ChoiceField(
        choices=UserStatus.values,
        error_messages={"invalid_choice": f"Status must be one of: {', '.join(UserStatus.values)}"},
    )


class UserListQuery(serializers.Serializer):
    page = serializers.IntegerField(required=False, min_value=1, max_value=10_000)
    limit = serializers.IntegerField(required=False, min_value=1, max_value=100)
    search = serializers.CharField(required=False, allow_blank=True, max_length=100)
    role = serializers.ChoiceField(choices=[], required=False)
    status = serializers.ChoiceField(choices=UserStatus.values, required=False)

    def __init__(self, *args: Any, roles: tuple[Role, ...] = (), **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        role_field = self.fields["role"]
        if isinstance(role_field, serializers.ChoiceField):
            role_field.choices = [r.value for r in roles]


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
def user_json(user: User) -> dict[str, Any]:
    """The user as the Angular app expects it (Node User.toJSON): no secrets, admin permissions."""
    data: dict[str, Any] = {
        "id": str(user.pk),
        "name": user.name,
        "email": user.email,
        "role": user.role,
        "status": user.status,
        "created_at": user.created_at,
        "updated_at": user.updated_at,
    }
    # Optional fields are left out when empty, as MongoDB documents omitted them.
    optional = {
        "phone": user.phone,
        "last_login_at": user.last_login,
        "referral_code": user.referral_code,
        "birth_date": user.birth_date,
    }
    data.update({k: v for k, v in optional.items() if v})
    if user.role in ADMIN_ROLES:
        data["permissions"] = user.permissions
    return data


class UserOut(serializers.Serializer):
    """Schema only (responses are built by user_json)."""

    id = serializers.UUIDField()
    name = serializers.CharField()
    email = serializers.EmailField()
    phone = serializers.CharField(required=False)
    role = serializers.ChoiceField(choices=[r.value for r in Role])
    status = serializers.ChoiceField(choices=UserStatus.values)
    last_login_at = serializers.DateTimeField(required=False)
    referral_code = serializers.CharField(required=False)
    birth_date = serializers.DateField(required=False)
    permissions = serializers.ListField(child=serializers.CharField(), required=False)
    created_at = serializers.DateTimeField()
    updated_at = serializers.DateTimeField()
