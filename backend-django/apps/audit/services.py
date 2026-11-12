"""
Admin audit log (Node: services/audit.service.js). `@audited(...)` on an admin view records one
entry after the request succeeds; recording is best-effort and never fails the admin's action.
"""

import functools
import ipaddress
import logging
from collections.abc import Callable
from datetime import datetime
from typing import Any

from django.db.models import Q
from rest_framework.request import Request
from rest_framework.response import Response

from common.pagination import Page, paginate

from .models import AuditLog

logger = logging.getLogger("bitebox.audit")


def _ip(request: Request) -> str | None:
    value = request.META.get("REMOTE_ADDR", "")
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        return None


def record(
    user: Any, action: str, resource_type: str, resource_id: Any, description: str, ip: str | None
) -> None:
    try:
        AuditLog.objects.create(
            admin=user,
            admin_role=user.role,
            action=action,
            description=str(description)[:500],
            resource_type=resource_type,
            resource_id=str(resource_id or "")[:64],
            ip=ip,
        )
    except Exception:
        logger.exception("Could not write audit log", extra={"action": action})


def audited(
    action: str, resource_type: str, describe: Callable[[Request], str]
) -> Callable[..., Any]:
    """
    Decorates an admin view method. After a successful (< 400) response, records `action` against
    `kwargs["id"]`, or `request.audit_resource_id` when the view creates the resource.
    """

    def decorator(view: Callable[..., Response]) -> Callable[..., Response]:
        @functools.wraps(view)
        def wrapper(self: Any, request: Request, *args: Any, **kwargs: Any) -> Response:
            response = view(self, request, *args, **kwargs)
            if response.status_code < 400 and request.user is not None:
                record(
                    request.user,
                    action,
                    resource_type,
                    kwargs.get("id") or getattr(request, "audit_resource_id", None),
                    describe(request),
                    _ip(request),
                )
            return response

        return wrapper

    return decorator


def list_entries(query: dict[str, Any], page: Page) -> dict[str, Any]:
    qs = AuditLog.objects.select_related("admin").order_by("-created_at")
    if query.get("action"):
        qs = qs.filter(action=query["action"])
    if query.get("role"):
        qs = qs.filter(admin_role=query["role"])
    if search := (query.get("search") or "").strip():
        qs = qs.filter(Q(description__icontains=search) | Q(resource_id=search))
    start: datetime | None = query.get("from")
    end: datetime | None = query.get("to")
    if start:
        qs = qs.filter(created_at__gte=start)
    if end:
        qs = qs.filter(created_at__lte=end)
    items, meta = paginate(qs, page)
    return {
        "items": [
            {
                "id": str(e.pk),
                "admin": {"id": str(e.admin.pk), "name": e.admin.name, "email": e.admin.email}
                if e.admin
                else None,
                "admin_role": e.admin_role,
                "action": e.action,
                "description": e.description,
                "resource_type": e.resource_type,
                "resource_id": e.resource_id,
                "ip": e.ip,
                "created_at": e.created_at,
            }
            for e in items
        ],
        "pagination": meta,
    }
