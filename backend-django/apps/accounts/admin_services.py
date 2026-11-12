"""Account administration (Node: services/admin-staff.service.js)."""

import uuid
from typing import Any

from django.db import transaction
from django.db.models import Q

from apps.delivery.models import DeliveryPartner
from apps.rbac.roles import ADMIN_ROLES, MEMBER_ROLES, STAFF_ADMIN_ROLES, Role
from common.api import ApiError
from common.pagination import Page, paginate

from .models import RevokedReason, User, UserStatus
from .serializers import user_json
from .services import end_sessions


def list_users(roles: tuple[Role, ...], query: dict[str, Any], page: Page) -> dict[str, Any]:
    """A page of accounts with one of `roles` (or just query["role"]), newest first."""
    qs = (
        User.objects.filter(role=query["role"])
        if query.get("role")
        else User.objects.filter(role__in=roles)
    )
    if query.get("status"):
        qs = qs.filter(status=query["status"])
    if search := (query.get("search") or "").strip():
        qs = qs.filter(
            Q(name__icontains=search) | Q(email__icontains=search) | Q(phone__icontains=search)
        )
    items, meta = paginate(qs.order_by("-created_at"), page)
    return {"items": [user_json(u) for u in items], "pagination": meta}


def list_members(query: dict[str, Any], page: Page) -> dict[str, Any]:
    return list_users(MEMBER_ROLES, query, page)


def list_staff(query: dict[str, Any], page: Page) -> dict[str, Any]:
    return list_users(ADMIN_ROLES, query, page)


def set_account_status(
    actor: User, user_id: uuid.UUID, status: str, roles: tuple[Role, ...]
) -> User:
    """
    Suspends or reactivates an account whose role is in `roles` (Users page: member roles; Admin
    management: admin roles). A suspended account is signed out everywhere at once.
    """
    if actor.pk == user_id:
        raise ApiError.bad_request("You cannot suspend your own account")
    user = User.objects.filter(pk=user_id).first()
    if user is None:
        raise ApiError.not_found("User not found")
    if user.role not in roles:
        raise ApiError.bad_request(
            "Manage admin accounts from Admin management"
            if user.role in ADMIN_ROLES
            else "This is not an admin account"
        )
    with transaction.atomic():
        if user.role == Role.DELIVERY and status == UserStatus.SUSPENDED:
            _take_rider_offline(user)
        user.status = status
        end_sessions(
            user,
            RevokedReason.SUSPENDED if status == UserStatus.SUSPENDED else RevokedReason.LOGOUT,
            fields=("status",),
        )
    return user


def _take_rider_offline(user: User) -> None:
    """Same rule as the riders page: never mid-delivery; an open offer goes to the next rider."""
    from apps.delivery.services import take_offline

    take_offline(
        user,
        DeliveryPartner.objects.filter(user=user).first(),
        "This rider is carrying an order. Unassign or finish it first.",
    )


def get_staff(user_id: uuid.UUID) -> User:
    user = User.objects.filter(pk=user_id, role__in=ADMIN_ROLES).first()
    if user is None:
        raise ApiError.not_found("Admin not found")
    return user


def create_staff(data: dict[str, Any]) -> User:
    if data["role"] not in STAFF_ADMIN_ROLES:
        raise ApiError.bad_request("Choose an operations, finance or support role")
    if User.objects.filter(email=data["email"]).exists():
        raise ApiError.conflict("An account with this email already exists")
    phone = data.get("phone") or None
    if phone and User.objects.filter(phone=phone).exists():
        raise ApiError.conflict("An account with this phone number already exists")
    return User.objects.create_user(
        data["email"], data["password"], data["name"], phone=phone, role=data["role"]
    )


def update_staff(actor: User, user_id: uuid.UUID, data: dict[str, Any]) -> User:
    """Edits a staff admin. Super admins aren't editable here; a role change signs the admin out."""
    if actor.pk == user_id:
        raise ApiError.bad_request("Use your profile page to edit your own account")
    user = User.objects.filter(pk=user_id, role__in=STAFF_ADMIN_ROLES).first()
    if user is None:
        raise ApiError.not_found("Admin not found")
    phone = data.get("phone")
    if phone and phone != user.phone and User.objects.filter(phone=phone).exists():
        raise ApiError.conflict("An account with this phone number already exists")

    fields: list[str] = []
    if "name" in data:
        user.name = data["name"]
        fields.append("name")
    if "phone" in data:
        user.phone = phone or None
        fields.append("phone")
    role = data.get("role")
    if role and role != user.role:
        user.role = role
        end_sessions(user, RevokedReason.ROLE_CHANGE, fields=(*fields, "role"))
    elif fields:
        user.save(update_fields=[*fields, "updated_at"])
    return user


def login_history(user_id: uuid.UUID, roles: tuple[Role, ...], page: Page) -> dict[str, Any]:
    """
    Sign-ins of one account, newest first (master prompt §3D "login history"). A sign-in is a
    session family: refreshes rotate the token inside it, so its first row is the sign-in and its
    newest row says whether it is still active.
    """
    from django.db.models import Max, Min
    from django.utils import timezone

    from .models import Session

    if not User.objects.filter(pk=user_id, role__in=roles).exists():
        raise ApiError.not_found("User not found")
    families = (
        Session.objects.filter(user_id=user_id)
        .values("family")
        .annotate(started=Min("created_at"), last=Max("created_at"))
        .order_by("-started")
    )
    rows, meta = paginate(families, page)
    firsts: dict[str, Session] = {}
    latest: dict[str, Session] = {}
    for s in Session.objects.filter(
        user_id=user_id, family__in=[r["family"] for r in rows]
    ).order_by("created_at"):
        firsts.setdefault(s.family, s)  # the sign-in
        latest[s.family] = s  # its newest refresh
    now = timezone.now()
    items = []
    for r in rows:
        first, last = firsts.get(r["family"]), latest.get(r["family"])
        if first is None or last is None:
            continue
        active = last.revoked_at is None and last.expires_at > now
        items.append(
            {
                "signed_in_at": r["started"],
                "last_active_at": r["last"],
                "ip": first.ip,
                "user_agent": first.user_agent,
                "active": active,
                "ended_reason": None if active else (last.revoked_reason or "expired"),
            }
        )
    return {"items": items, "pagination": meta}
