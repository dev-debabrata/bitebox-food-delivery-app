"""
Roles and admin permissions. A port of backend/config/roles.js and backend/config/permissions.js;
the values are part of the API contract (user JSON, the Angular `Permission` type) and must not
drift. They live in code, not tables (docs/django-migration README, decision D4).
"""

from enum import StrEnum


class Role(StrEnum):
    CUSTOMER = "customer"
    ADMIN = "admin"  # the super admin: every permission, and the only role that manages admins
    RESTAURANT = "restaurant"
    DELIVERY = "delivery"
    OPERATIONS_ADMIN = "operations_admin"
    FINANCE_ADMIN = "finance_admin"
    SUPPORT_ADMIN = "support_admin"


ALL_ROLES: tuple[Role, ...] = tuple(Role)
STAFF_ADMIN_ROLES: tuple[Role, ...] = (
    Role.OPERATIONS_ADMIN,
    Role.FINANCE_ADMIN,
    Role.SUPPORT_ADMIN,
)
ADMIN_ROLES: tuple[Role, ...] = (Role.ADMIN, *STAFF_ADMIN_ROLES)
MEMBER_ROLES: tuple[Role, ...] = tuple(r for r in ALL_ROLES if r not in ADMIN_ROLES)

# Plain value lists (OpenAPI enum names, serializer choices).
ALL_ROLE_VALUES = [r.value for r in ALL_ROLES]
STAFF_ROLE_VALUES = [r.value for r in STAFF_ADMIN_ROLES]
ADMIN_ROLE_VALUES = [r.value for r in ADMIN_ROLES]

ROLE_LABEL: dict[Role, str] = {
    Role.CUSTOMER: "Customer",
    Role.ADMIN: "Super admin",
    Role.RESTAURANT: "Restaurant partner",
    Role.DELIVERY: "Delivery partner",
    Role.OPERATIONS_ADMIN: "Operations admin",
    Role.FINANCE_ADMIN: "Finance admin",
    Role.SUPPORT_ADMIN: "Support admin",
}


class Permission(StrEnum):
    ADMINS_MANAGE = "admins:manage"
    USERS_MANAGE = "users:manage"
    AUDIT_VIEW = "audit:view"
    CATALOG_MANAGE = "catalog:manage"
    OPERATIONS_VIEW = "operations:view"
    ORDERS_VIEW = "orders:view"
    ORDERS_MANAGE = "orders:manage"
    RESTAURANTS_MANAGE = "restaurants:manage"
    RIDERS_MANAGE = "riders:manage"
    FINANCE_VIEW = "finance:view"
    REFUNDS_MANAGE = "refunds:manage"
    PAYOUTS_MANAGE = "payouts:manage"
    SUPPORT_MANAGE = "support:manage"
    REVIEWS_MODERATE = "reviews:moderate"
    REWARDS_MANAGE = "rewards:manage"
    REWARDS_VIEW = "rewards:view"
    PROMOTIONS_SEND = "promotions:send"


P = Permission

ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    Role.ADMIN: frozenset(Permission),
    Role.OPERATIONS_ADMIN: frozenset(
        {P.OPERATIONS_VIEW, P.ORDERS_VIEW, P.ORDERS_MANAGE, P.RESTAURANTS_MANAGE, P.RIDERS_MANAGE}
    ),
    Role.FINANCE_ADMIN: frozenset({P.FINANCE_VIEW, P.REFUNDS_MANAGE, P.PAYOUTS_MANAGE}),
    # Support reads orders to investigate complaints, but cannot change them or see finance.
    Role.SUPPORT_ADMIN: frozenset({P.SUPPORT_MANAGE, P.ORDERS_VIEW, P.REVIEWS_MODERATE}),
}


def permissions_for(role: str | None) -> frozenset[Permission]:
    try:
        return ROLE_PERMISSIONS.get(Role(role), frozenset()) if role else frozenset()
    except ValueError:
        return frozenset()


def has_permission(role: str | None, permission: Permission) -> bool:
    return permission in permissions_for(role)
