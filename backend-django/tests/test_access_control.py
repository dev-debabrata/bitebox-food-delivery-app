"""
Access-control matrix (security plan §7.4): every API route × every method × every role.

Permissions are deny-by-default (REST_FRAMEWORK DEFAULT_PERMISSION_CLASSES = IsSignedIn), and the
routes anyone may call are listed in PUBLIC below, so a new public endpoint is a deliberate change.
For each route and role the test works out from the view's own permission classes whether the role
is allowed, then calls the API: a role without access must get 403, and anonymous callers 401,
before the view runs (ids in the path are random, so nothing is found even where access is allowed).
"""

import re
import uuid
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest
from django.urls import URLPattern, URLResolver, get_resolver
from rest_framework.test import APIClient
from rest_framework.views import APIView

from apps.accounts.tokens import sign_access_token
from apps.rbac.roles import Role
from tests.factories import user

pytestmark = pytest.mark.django_db

# Everything an anonymous caller may reach. Keep in step with the Node API's public routes.
PUBLIC = {
    ("api/v1/health", "get"),
    ("api/v1/health/live", "get"),
    ("api/v1/health/ready", "get"),
    ("api/v1/auth/register", "post"),
    ("api/v1/auth/register/code", "post"),
    ("api/v1/auth/methods", "get"),
    ("api/v1/auth/login", "post"),
    ("api/v1/auth/refresh", "post"),
    ("api/v1/auth/logout", "post"),
    ("api/v1/auth/forgot-password", "post"),
    ("api/v1/auth/reset-password", "post"),
    ("api/v1/auth/otp/request", "post"),
    ("api/v1/auth/otp/login", "post"),
    ("api/v1/auth/email/verify", "post"),
    ("api/v1/restaurants", "get"),
    ("api/v1/restaurants/cuisines", "get"),
    ("api/v1/restaurants/<str:slug_or_id>", "get"),
    ("api/v1/restaurants/<str:slug_or_id>/menu", "get"),
    ("api/v1/restaurants/<str:slug_or_id>/reviews", "get"),
    ("api/v1/categories", "get"),
    ("api/v1/foods", "get"),
    ("api/v1/foods/<str:id>", "get"),
    ("api/v1/foods/<str:id>/reviews", "get"),
    ("api/v1/geo/search", "get"),
    ("api/v1/geo/reverse", "get"),
    ("api/v1/referrals/validate", "post"),  # the sign-up form; rate limited
    ("api/v1/payments/methods", "get"),
    ("api/v1/payments/webhooks/razorpay", "post"),  # signed by Razorpay (HMAC), not a user
    ("api/v1/push/public-key", "get"),
    ("api/v1/newsletter/subscriptions", "post"),
}

METHODS = ("get", "post", "put", "patch", "delete")
PARAM = re.compile(r"<(?:(\w+):)?\w+>")


def _walk(patterns: Any, prefix: str = "") -> Iterator[tuple[str, type[APIView]]]:
    for p in patterns:
        if isinstance(p, URLResolver):
            yield from _walk(p.url_patterns, prefix + str(p.pattern))
        elif isinstance(p, URLPattern):
            route = prefix + str(p.pattern)
            view = getattr(p.callback, "cls", None)
            if route.startswith("api/v1/") and view is not None:
                yield route, view


def endpoints() -> list[tuple[str, str, type[APIView]]]:
    return [
        (route, m, view)
        for route, view in _walk(get_resolver().url_patterns)
        for m in METHODS
        if hasattr(view, m)
    ]


def url_for(route: str) -> str:
    """A concrete URL with random ids: permission checks run before any lookup."""

    def fill(m: re.Match[str]) -> str:
        return "1" if m.group(1) == "int" else str(uuid.uuid4())

    return "/" + PARAM.sub(fill, route)


def allows(view: type[APIView], method: str, role: Role | None) -> bool:
    """What the view's own permission classes say for this role (no request, no database)."""
    instance = view()
    instance.request = SimpleNamespace(  # type: ignore[assignment]
        method=method.upper(),
        user=SimpleNamespace(is_authenticated=role is not None, role=role and role.value),
    )
    instance.kwargs, instance.args = {}, ()
    return all(p.has_permission(instance.request, instance) for p in instance.get_permissions())


def test_only_the_listed_routes_are_public() -> None:
    public = {(route, m) for route, m, view in endpoints() if allows(view, m, None)}
    assert public == PUBLIC, "a route became public, or a public route was removed: update PUBLIC"


def test_anonymous_callers_get_401_everywhere_else(api: APIClient) -> None:
    refused = []
    for route, method, _ in endpoints():
        if (route, method) in PUBLIC:
            continue
        res = getattr(api, method)(url_for(route), {}, format="json")
        if res.status_code != 401:
            refused.append(f"{method.upper()} {route} -> {res.status_code}")
    assert refused == []


def test_every_role_gets_403_where_it_has_no_access() -> None:
    wrong = []
    checked = 0
    for role in Role:
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {sign_access_token(user(role))}")
        for route, method, view in endpoints():
            if allows(view, method, role):
                continue
            checked += 1
            res = getattr(client, method)(url_for(route), {}, format="json")
            if res.status_code != 403:
                wrong.append(f"{role} {method.upper()} {route} -> {res.status_code}")
    assert wrong == []
    assert checked > 500  # the matrix really ran (7 roles × ~200 endpoints)


def test_the_matrix_matches_the_role_model() -> None:
    """Spot checks that `allows` reads permissions the way the API applies them."""
    by_key = {(r, m): v for r, m, v in endpoints()}
    finance = by_key[("api/v1/admin/finance/dashboard", "get")]
    assert allows(finance, "get", Role.FINANCE_ADMIN)
    assert not allows(finance, "get", Role.SUPPORT_ADMIN)
    assert not allows(finance, "get", Role.CUSTOMER)
    assert allows(by_key[("api/v1/cart", "get")], "get", Role.CUSTOMER)
    assert not allows(by_key[("api/v1/cart", "get")], "get", Role.DELIVERY)
    assert all(
        allows(by_key[("api/v1/admin/admins", "get")], "get", r) is (r == Role.ADMIN) for r in Role
    )
