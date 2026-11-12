"""
/api/v1/admin/users, /admin/admins and /admin/audit-logs (Node: routes/admin-users.routes.js,
routes/admin-staff.routes.js). Each needs an admin permission, never just a role.
"""

from typing import Any

from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.audit.services import audited, list_entries
from apps.rbac.roles import ADMIN_ROLES, MEMBER_ROLES, ROLE_LABEL, Permission, Role
from common.api import ok
from common.pagination import Page
from common.permissions import permission_required
from common.schema import envelope, errors
from common.validation import PageQuery, parse_id, validated

from . import admin_services as admin
from .authentication import current_user
from .serializers import (
    StaffCreateInput,
    StaffUpdateInput,
    StatusInput,
    UserListQuery,
    UserOut,
    user_json,
)

PAGINATION = inline_serializer(
    name="Pagination",
    fields={k: serializers.IntegerField() for k in ("page", "limit", "total", "total_pages")},
)
USER_PAGE = envelope(
    "UserPage",
    inline_serializer(
        name="UserPageData", fields={"items": UserOut(many=True), "pagination": PAGINATION}
    ),
)
USER = envelope(
    "AdminUserResponse", inline_serializer(name="AdminUserData", fields={"user": UserOut()})
)
LIST_PARAMS = [
    OpenApiParameter("page", int),
    OpenApiParameter("limit", int),
    OpenApiParameter("search", str),
    OpenApiParameter("role", str),
    OpenApiParameter("status", str, enum=["active", "suspended"]),
]


def _list_query(request: Request, roles: tuple[Role, ...]) -> tuple[dict[str, Any], Page]:
    query = validated(UserListQuery, request.query_params, roles=roles)
    return query, Page.from_query(query)


class MembersView(APIView):
    permission_classes = [permission_required(Permission.USERS_MANAGE)]

    @extend_schema(
        tags=["Admin: users"],
        parameters=LIST_PARAMS,
        responses={200: USER_PAGE, **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query, page = _list_query(request, MEMBER_ROLES)
        return ok(admin.list_members(query, page))


class MemberStatusView(APIView):
    permission_classes = [permission_required(Permission.USERS_MANAGE)]

    @extend_schema(
        tags=["Admin: users"],
        request=StatusInput,
        responses={200: USER, **errors(400, 401, 403, 404, 409, 422)},
    )
    @audited("user.status", "user", lambda r: f"Set account status to {r.data.get('status')}")
    def patch(self, request: Request, id: str) -> Response:
        status = validated(StatusInput, request.data)["status"]
        user = admin.set_account_status(current_user(request), parse_id(id), status, MEMBER_ROLES)
        return ok(
            {"user": user_json(user)},
            message="User reactivated" if status == "active" else "User suspended",
        )


def _role_label(value: object) -> str:
    try:
        return ROLE_LABEL[Role(str(value))]
    except ValueError:
        return str(value)


def _staff_update_description(request: Request) -> str:
    role = request.data.get("role")
    return f"Updated admin; role set to {_role_label(role)}" if role else "Updated admin details"


class StaffListView(APIView):
    permission_classes = [permission_required(Permission.ADMINS_MANAGE)]

    @extend_schema(
        tags=["Admin: staff"],
        operation_id="admin_admins_list",
        parameters=LIST_PARAMS,
        responses={200: USER_PAGE, **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query, page = _list_query(request, ADMIN_ROLES)
        return ok(admin.list_staff(query, page))

    @extend_schema(
        tags=["Admin: staff"],
        request=StaffCreateInput,
        responses={201: USER, **errors(401, 403, 409, 422)},
    )
    @audited(
        "admin.create",
        "user",
        lambda r: f"Created {_role_label(r.data.get('role'))} {r.data.get('email')}",
    )
    def post(self, request: Request) -> Response:
        user = admin.create_staff(validated(StaffCreateInput, request.data))
        request.audit_resource_id = user.pk  # type: ignore[attr-defined]
        return ok({"user": user_json(user)}, message="Admin created", status=201)


class StaffDetailView(APIView):
    permission_classes = [permission_required(Permission.ADMINS_MANAGE)]

    @extend_schema(
        tags=["Admin: staff"],
        operation_id="admin_admins_detail",
        responses={200: USER, **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        return ok({"user": user_json(admin.get_staff(parse_id(id)))})

    @extend_schema(
        tags=["Admin: staff"],
        request=StaffUpdateInput,
        responses={200: USER, **errors(400, 401, 403, 404, 409, 422)},
    )
    @audited("admin.update", "user", _staff_update_description)
    def patch(self, request: Request, id: str) -> Response:
        data = validated(StaffUpdateInput, request.data, partial=True)
        user = admin.update_staff(current_user(request), parse_id(id), data)
        return ok({"user": user_json(user)}, message="Admin updated")


class StaffStatusView(APIView):
    permission_classes = [permission_required(Permission.ADMINS_MANAGE)]

    @extend_schema(
        tags=["Admin: staff"],
        request=StatusInput,
        responses={200: USER, **errors(400, 401, 403, 404, 422)},
    )
    @audited(
        "admin.status",
        "user",
        lambda r: "Activated admin" if r.data.get("status") == "active" else "Deactivated admin",
    )
    def patch(self, request: Request, id: str) -> Response:
        status = validated(StatusInput, request.data)["status"]
        user = admin.set_account_status(current_user(request), parse_id(id), status, ADMIN_ROLES)
        return ok(
            {"user": user_json(user)},
            message="Admin activated" if status == "active" else "Admin deactivated",
        )


class AuditQuery(serializers.Serializer):
    page = serializers.IntegerField(required=False, min_value=1, max_value=10_000)
    limit = serializers.IntegerField(required=False, min_value=1, max_value=100)
    search = serializers.CharField(required=False, allow_blank=True, max_length=100)
    action = serializers.CharField(required=False, max_length=60)
    role = serializers.ChoiceField(choices=[r.value for r in ADMIN_ROLES], required=False)
    to = serializers.DateTimeField(required=False)

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        # "from" is a Python keyword, so it can't be declared as a class attribute.
        self.fields["from"] = serializers.DateTimeField(required=False)


AUDIT_ENTRY = inline_serializer(
    name="AuditEntry",
    fields={
        "id": serializers.UUIDField(),
        "admin": inline_serializer(
            name="AuditAdmin",
            fields={
                "id": serializers.UUIDField(),
                "name": serializers.CharField(),
                "email": serializers.EmailField(),
            },
            allow_null=True,
        ),
        "admin_role": serializers.CharField(),
        "action": serializers.CharField(),
        "description": serializers.CharField(),
        "resource_type": serializers.CharField(),
        "resource_id": serializers.CharField(),
        "ip": serializers.IPAddressField(allow_null=True),
        "created_at": serializers.DateTimeField(),
    },
    many=True,
)


class AuditLogView(APIView):
    permission_classes = [permission_required(Permission.AUDIT_VIEW)]

    @extend_schema(
        tags=["Admin: audit"],
        parameters=[
            *LIST_PARAMS[:3],
            OpenApiParameter("action", str),
            OpenApiParameter("role", str),
            OpenApiParameter("from", str),
            OpenApiParameter("to", str),
        ],
        responses={
            200: envelope(
                "AuditPage",
                inline_serializer(
                    name="AuditPageData", fields={"items": AUDIT_ENTRY, "pagination": PAGINATION}
                ),
            ),
            **errors(401, 403, 422),
        },
    )
    def get(self, request: Request) -> Response:
        query = validated(AuditQuery, request.query_params)
        return ok(list_entries(query, Page.from_query(query)))


class _LoginHistoryView(APIView):
    roles: tuple[Role, ...] = ()

    def get(self, request: Request, id: str) -> Response:
        user_id = parse_id(id)
        query = validated(PageQuery, request.query_params)
        return ok(admin.login_history(user_id, self.roles, Page.from_query(query)))


class MemberLoginsView(_LoginHistoryView):
    """Sign-ins of a customer, restaurant partner or rider."""

    permission_classes = [permission_required(Permission.USERS_MANAGE)]
    roles = MEMBER_ROLES

    @extend_schema(
        tags=["Admin: users"],
        operation_id="admin_users_logins",
        parameters=[PageQuery],
        responses={200: envelope("LoginHistory"), **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        return super().get(request, id)


class StaffLoginsView(_LoginHistoryView):
    """Sign-ins of a staff admin (admin security: login history)."""

    permission_classes = [permission_required(Permission.ADMINS_MANAGE)]
    roles = ADMIN_ROLES

    @extend_schema(
        tags=["Admin: staff"],
        operation_id="admin_admins_logins",
        parameters=[PageQuery],
        responses={200: envelope("StaffLoginHistory"), **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        return super().get(request, id)
