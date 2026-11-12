"""
DRF permission classes: the Django side of `authorize(...roles)` and `can(PERMISSIONS.X)` in the
Node API. Use them in `permission_classes`:

    permission_classes = [role_required(Role.RESTAURANT)]
    permission_classes = [permission_required(Permission.ORDERS_MANAGE)]

Admin routes check a permission, never a role. Ownership (a restaurant's own orders, a rider's
own delivery) is enforced in selectors from `request.user`, never from ids sent by the client.
"""

from typing import Any

from rest_framework.permissions import BasePermission
from rest_framework.request import Request

from apps.rbac.roles import Permission, Role, has_permission


def _user_role(request: Request) -> str | None:
    user = getattr(request, "user", None)
    if user is None or not getattr(user, "is_authenticated", False):
        return None
    return getattr(user, "role", None)


class IsSignedIn(BasePermission):
    def has_permission(self, request: Request, view: Any) -> bool:
        return _user_role(request) is not None


def role_required(*roles: Role) -> type[BasePermission]:
    """Any of these roles. Anonymous → 401, wrong role → 403."""
    allowed = frozenset(roles)

    class RoleRequired(IsSignedIn):
        def has_permission(self, request: Request, view: Any) -> bool:
            role = _user_role(request)
            return role is not None and role in allowed

    RoleRequired.__name__ = f"RoleRequired({', '.join(sorted(allowed))})"
    return RoleRequired


def permission_required(permission: Permission) -> type[BasePermission]:
    """An admin permission (the super admin has every one). Anonymous → 401, missing → 403."""

    class PermissionRequired(IsSignedIn):
        message = "You do not have access to this area"  # Node: can(...)

        def has_permission(self, request: Request, view: Any) -> bool:
            return has_permission(_user_role(request), permission)

    PermissionRequired.__name__ = f"PermissionRequired({permission})"
    return PermissionRequired
