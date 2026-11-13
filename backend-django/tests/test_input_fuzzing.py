"""
Hostile input on every list and search endpoint (security plan §7.4): SQL and NoSQL injection
strings, NUL bytes, very long and odd Unicode values in query parameters. Each GET route is called
as a role that may use it; the API must answer with data or a validation error, never a 500.
"""

import pytest
from rest_framework.test import APIClient

from apps.accounts.tokens import sign_access_token
from apps.rbac.roles import Role
from common.seed import seed
from tests.factories import user
from tests.test_access_control import allows, endpoints, url_for

pytestmark = pytest.mark.django_db

PAYLOADS = [
    "' OR '1'='1' --",
    '{"$gt": ""}',
    "\x00",
    "a\x00b",
    "%' UNION SELECT password FROM users --",
    "<script>alert(1)</script>",
    "../../../../etc/passwd",
    "9" * 400,
    "-1",
    "1e309",
    "𝔘𝔫𝔦𝔠𝔬𝔡𝔢 ☃",
    "x" * 5000,
]
PARAMS = [
    "search", "q", "status", "type", "method", "provider", "sort", "cuisine", "category",
    "restaurant", "restaurantId", "veg", "from", "to", "days", "lat", "lng", "rating",
    "orderState", "role", "page", "limit",
]  # fmt: skip


@pytest.fixture
def clients() -> dict[Role | None, APIClient]:
    seed("Fuzz-pass-123")  # some data, so filters reach real rows
    out: dict[Role | None, APIClient] = {None: APIClient()}
    for role in Role:
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {sign_access_token(user(role))}")
        out[role] = client
    return out


def _gets() -> list[tuple[str, Role | None]]:
    """Each GET route with a role that may call it (None: anonymous)."""
    out: list[tuple[str, Role | None]] = []
    for route, method, view in endpoints():
        roles = [r for r in (None, *Role) if method == "get" and allows(view, "get", r)]
        if roles:
            out.append((route, roles[0]))
    return out


def test_hostile_query_parameters_never_cause_a_server_error(
    clients: dict[Role | None, APIClient],
) -> None:
    errors = []
    for route, role in _gets():
        client, url = clients[role], url_for(route)
        for payload in PAYLOADS:
            # All parameters at once, then each text parameter alone (so a validation error on
            # one does not hide what another does).
            for query in ({p: payload for p in PARAMS}, {"search": payload}, {"status": payload}):
                res = client.get(url, query)
                # 503 is the API's answer when an upstream (Redis, Nominatim) is down.
                if res.status_code >= 500 and res.status_code != 503:
                    first = next(iter(query))
                    errors.append(
                        f"{role} GET {route} {first}={payload[:20]!r} -> {res.status_code}"
                    )
                    break
    assert errors == []
