"""
Port of the Node API's tests/auth.test.js: the same scenarios and status codes, so the Angular
app sees identical behaviour from either backend.
"""

import re
from datetime import timedelta
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from django.core import mail
from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Session, User
from common.seed import SEED_USERS, seed

pytestmark = pytest.mark.django_db

ORIGIN = "http://localhost:4200"
PASSWORD = "Sup3rSecret!1"
COOKIE = "bb_refresh"


@pytest.fixture(autouse=True)
def _clear_rate_limits() -> None:
    cache.clear()


_n = iter(range(10_000))


def register(api: APIClient, **overrides: Any) -> tuple[Any, dict[str, Any]]:
    body = {
        "name": "Test User",
        "email": f"user{next(_n)}@example.com",
        "password": PASSWORD,
        **overrides,
    }
    return api.post("/api/v1/auth/register", body, format="json"), body


def token_of(res: Any) -> str:
    return str(res.json()["data"]["accessToken"])


def cookie_of(res: Any) -> str | None:
    morsel = res.cookies.get(COOKIE)
    return morsel.value if morsel and morsel.value else None


def refresh_with(cookie: str | None, **headers: str) -> Any:
    client = APIClient()
    if cookie:
        client.cookies[COOKIE] = cookie
    defaults = {"HTTP_ORIGIN": ORIGIN, "HTTP_X_REQUESTED_WITH": "BiteBox"}
    return client.post("/api/v1/auth/refresh", **{**defaults, **headers})


def me(token: str) -> Any:
    return APIClient().get("/api/v1/auth/me", HTTP_AUTHORIZATION=f"Bearer {token}")


def login(email: str, password: str = PASSWORD, **extra: Any) -> Any:
    return APIClient().post(
        "/api/v1/auth/login", {"email": email, "password": password, **extra}, format="json"
    )


def create_and_login(role: str) -> dict[str, Any]:
    seed(PASSWORD)
    email = next(e for _, e, _, r in SEED_USERS if r == role)
    res = login(email)
    return {"token": token_of(res), "user": res.json()["data"]["user"]}


# --- registration -------------------------------------------------------------------------------


def test_registers_a_customer_hashes_the_password_and_never_returns_it(api: APIClient) -> None:
    res, body = register(api, email="Asha@Example.com")
    assert res.status_code == 201
    data = res.json()["data"]
    assert data["user"]["email"] == "asha@example.com"
    assert data["user"]["role"] == "customer"
    assert "password" not in data["user"]
    assert "permissions" not in data["user"]
    assert data["accessToken"]
    stored = User.objects.get(email="asha@example.com")
    assert stored.password != body["password"]
    assert stored.password.startswith("argon2")


def test_sets_the_refresh_cookie_httponly_samesite_scoped_to_auth(api: APIClient) -> None:
    res, _ = register(api)
    morsel = res.cookies[COOKIE]
    assert morsel["httponly"]
    assert morsel["samesite"] == "Strict"
    assert morsel["path"] == "/api/v1/auth"
    assert Session.objects.get().token_hash != morsel.value  # only a hash is stored


@pytest.mark.parametrize("role", ["restaurant", "delivery"])
def test_allows_partner_self_registration(api: APIClient, role: str) -> None:
    res, _ = register(api, role=role)
    assert res.status_code == 201
    assert res.json()["data"]["user"]["role"] == role


def test_rejects_self_registration_as_admin(api: APIClient) -> None:
    res, _ = register(api, role="admin")
    assert res.status_code == 422
    assert not User.objects.filter(role="admin").exists()


def test_rejects_duplicate_emails_with_409(api: APIClient) -> None:
    register(api, email="dup@example.com")
    res, _ = register(api, email="DUP@example.com")
    assert res.status_code == 409


def test_validates_input_and_reports_field_errors(api: APIClient) -> None:
    res, _ = register(api, name="A", email="not-an-email", password="short")
    assert res.status_code == 422
    assert sorted(d["field"] for d in res.json()["error"]["details"]) == [
        "email",
        "name",
        "password",
    ]


def test_rejects_objects_where_strings_are_expected() -> None:
    res = APIClient().post(
        "/api/v1/auth/login", {"email": {"$gt": ""}, "password": {"$gt": ""}}, format="json"
    )
    assert res.status_code == 422


# --- login --------------------------------------------------------------------------------------


def test_signs_in_with_correct_credentials(api: APIClient) -> None:
    _, body = register(api)
    res = login(body["email"])
    assert res.status_code == 200
    assert res.json()["data"]["accessToken"]
    assert cookie_of(res)
    assert User.objects.get(email=body["email"]).last_login is not None


def test_same_401_for_wrong_password_and_unknown_email(api: APIClient) -> None:
    _, body = register(api)
    wrong = login(body["email"], "Wrong-pass1")
    unknown = login("nobody@example.com")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json()["message"] == unknown.json()["message"]


def test_rejects_signing_in_to_another_roles_portal(api: APIClient) -> None:
    _, body = register(api)
    assert login(body["email"], portal="admin").status_code == 403


def test_blocks_suspended_accounts(api: APIClient) -> None:
    _, body = register(api)
    User.objects.filter(email=body["email"]).update(status="suspended")
    assert login(body["email"]).status_code == 403


@override_settings(AUTH_RATE_LIMIT="3/900s")
def test_rate_limits_repeated_login_attempts() -> None:
    attempt = lambda: login("x@example.com", "Wrong-pass1")  # noqa: E731
    for _ in range(3):
        assert attempt().status_code == 401
    limited = attempt()
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "RATE_LIMITED"
    assert limited.json()["message"] == "Too many attempts. Please try again in a few minutes."
    assert int(limited["Retry-After"]) > 0


# --- access tokens ------------------------------------------------------------------------------


def test_returns_the_current_user_for_a_valid_token(api: APIClient) -> None:
    res, body = register(api)
    current = me(token_of(res))
    assert current.status_code == 200
    assert current.json()["data"]["user"]["email"] == body["email"]


def test_rejects_missing_malformed_and_tampered_tokens(api: APIClient) -> None:
    res, _ = register(api)
    token = token_of(res)
    assert APIClient().get("/api/v1/auth/me").status_code == 401
    assert me("nope").status_code == 401
    tampered = token[:-2] + ("bb" if token.endswith("aa") else "aa")
    assert me(tampered).status_code == 401
    assert (
        APIClient().get("/api/v1/auth/me", HTTP_AUTHORIZATION=f"Basic {token}").status_code == 401
    )


def test_expired_tokens_say_so(api: APIClient) -> None:
    res, _ = register(api)
    with override_settings(JWT_ACCESS_TTL_SECONDS=-1):
        _, body = register(api)
        expired = token_of(login(body["email"]))
    reply = me(expired)
    assert reply.status_code == 401
    assert reply.json()["error"]["code"] == "TOKEN_EXPIRED"
    assert me(token_of(res)).status_code == 200


def test_invalidates_tokens_of_suspended_users_immediately(api: APIClient) -> None:
    res, body = register(api)
    User.objects.filter(email=body["email"]).update(status="suspended")
    assert me(token_of(res)).status_code == 401


def test_updates_the_profile_with_validated_fields_only(api: APIClient) -> None:
    res, _ = register(api)
    reply = APIClient().patch(
        "/api/v1/auth/me",
        {"name": "New Name", "phone": "+919876543210", "role": "admin"},
        format="json",
        HTTP_AUTHORIZATION=f"Bearer {token_of(res)}",
    )
    assert reply.status_code == 200
    user = reply.json()["data"]["user"]
    assert (user["name"], user["phone"], user["role"]) == ("New Name", "+919876543210", "customer")

    cleared = APIClient().patch(
        "/api/v1/auth/me",
        {"phone": ""},
        format="json",
        HTTP_AUTHORIZATION=f"Bearer {token_of(res)}",
    )
    assert "phone" not in cleared.json()["data"]["user"]


# --- refresh sessions ---------------------------------------------------------------------------


def test_rotates_the_refresh_token_and_issues_a_new_access_token(api: APIClient) -> None:
    res, _ = register(api)
    rotated = refresh_with(cookie_of(res))
    assert rotated.status_code == 200
    assert rotated.json()["data"]["accessToken"]
    assert cookie_of(rotated) not in (None, cookie_of(res))


def test_refresh_requires_the_csrf_header_and_a_trusted_origin(api: APIClient) -> None:
    res, _ = register(api)
    cookie = cookie_of(res)
    assert refresh_with(cookie, HTTP_X_REQUESTED_WITH="").status_code == 403
    assert refresh_with(cookie, HTTP_ORIGIN="https://evil.example").status_code == 403


def test_detects_reuse_and_revokes_the_whole_family(api: APIClient) -> None:
    res, _ = register(api)
    first = cookie_of(res)
    second = cookie_of(refresh_with(first))
    # Pretend the rotation happened outside the race window.
    Session.objects.filter(revoked_reason="rotated").update(
        revoked_at=timezone.now() - timedelta(minutes=1)
    )

    replay = refresh_with(first)
    assert replay.status_code == 401
    assert replay.cookies[COOKIE].value == ""  # cookie cleared
    assert refresh_with(second).status_code == 401  # the legitimate newer token died too


def test_near_simultaneous_reuse_is_a_race_and_reissues(api: APIClient) -> None:
    res, _ = register(api)
    first = cookie_of(res)
    assert refresh_with(first).status_code == 200
    race = refresh_with(first)
    assert race.status_code == 200
    assert race.json()["data"]["accessToken"]
    assert refresh_with(cookie_of(race)).status_code == 200


def test_logout_revokes_the_refresh_session(api: APIClient) -> None:
    res, _ = register(api)
    cookie = cookie_of(res)
    client = APIClient()
    client.cookies[COOKIE] = cookie or ""
    out = client.post("/api/v1/auth/logout", HTTP_ORIGIN=ORIGIN, HTTP_X_REQUESTED_WITH="BiteBox")
    assert out.status_code == 200
    assert refresh_with(cookie).status_code == 401


def test_refresh_without_a_cookie_is_401() -> None:
    assert refresh_with(None).status_code == 401


# --- password reset -----------------------------------------------------------------------------


def token_from_email() -> str:
    link = re.search(r"https?://\S+", mail.outbox[-1].body)
    assert link
    return parse_qs(urlparse(link.group(0)).query)["token"][0]


def test_forgot_password_responds_identically_for_known_and_unknown_emails(api: APIClient) -> None:
    _, body = register(api)
    known = api.post("/api/v1/auth/forgot-password", {"email": body["email"]}, format="json")
    unknown = api.post(
        "/api/v1/auth/forgot-password", {"email": "ghost@example.com"}, format="json"
    )
    assert known.status_code == unknown.status_code == 200
    assert known.json()["message"] == unknown.json()["message"]
    assert len(mail.outbox) == 1
    assert mail.outbox[0].to == [body["email"]]


def test_stores_only_a_hash_of_the_reset_token(api: APIClient) -> None:
    _, body = register(api)
    api.post("/api/v1/auth/forgot-password", {"email": body["email"]}, format="json")
    stored = User.objects.get(email=body["email"]).password_reset_token_hash
    assert stored
    assert stored != token_from_email()


def test_resets_once_and_revokes_sessions_and_access_tokens(api: APIClient) -> None:
    res, body = register(api)
    old_access, old_cookie = token_of(res), cookie_of(res)
    api.post("/api/v1/auth/forgot-password", {"email": body["email"]}, format="json")
    token = token_from_email()

    reset = api.post(
        "/api/v1/auth/reset-password",
        {"token": token, "password": "Brand-new-pass9"},
        format="json",
    )
    assert reset.status_code == 200
    again = api.post(
        "/api/v1/auth/reset-password", {"token": token, "password": "Another-pass9"}, format="json"
    )
    assert again.status_code == 400

    assert login(body["email"]).status_code == 401
    assert login(body["email"], "Brand-new-pass9").status_code == 200
    assert refresh_with(old_cookie).status_code == 401
    assert me(old_access).status_code == 401


def test_rejects_expired_reset_tokens(api: APIClient) -> None:
    _, body = register(api)
    api.post("/api/v1/auth/forgot-password", {"email": body["email"]}, format="json")
    User.objects.filter(email=body["email"]).update(
        password_reset_expires_at=timezone.now() - timedelta(seconds=1)
    )
    res = api.post(
        "/api/v1/auth/reset-password",
        {"token": token_from_email(), "password": "Brand-new-pass9"},
        format="json",
    )
    assert res.status_code == 400


def test_change_password_needs_the_current_one_and_signs_out_other_sessions(api: APIClient) -> None:
    res, _ = register(api)
    token, cookie = token_of(res), cookie_of(res)
    headers = {"HTTP_AUTHORIZATION": f"Bearer {token}"}
    wrong = APIClient().post(
        "/api/v1/auth/change-password",
        {"currentPassword": "Not-it-123", "newPassword": "Changed-pass1"},
        format="json",
        **headers,
    )
    assert wrong.status_code == 400
    ok = APIClient().post(
        "/api/v1/auth/change-password",
        {"currentPassword": PASSWORD, "newPassword": "Changed-pass1"},
        format="json",
        **headers,
    )
    assert ok.status_code == 200
    assert refresh_with(cookie).status_code == 401
    assert me(token).status_code == 401


# --- role authorization -------------------------------------------------------------------------


def test_admins_can_list_users() -> None:
    admin = create_and_login("admin")
    res = APIClient().get(
        "/api/v1/admin/users?role=customer&limit=10", HTTP_AUTHORIZATION=f"Bearer {admin['token']}"
    )
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["pagination"]["limit"] == 10
    assert data["items"]
    assert all(u["role"] == "customer" and "password" not in u for u in data["items"])


@pytest.mark.parametrize("role", ["customer", "restaurant", "delivery"])
def test_members_are_forbidden_from_admin_endpoints(role: str) -> None:
    who = create_and_login(role)
    res = APIClient().get("/api/v1/admin/users", HTTP_AUTHORIZATION=f"Bearer {who['token']}")
    assert res.status_code == 403
    assert res.json()["message"] == "You do not have access to this area"


def test_admin_endpoints_require_authentication() -> None:
    res = APIClient().get("/api/v1/admin/users")
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "UNAUTHORIZED"


def test_admins_suspend_and_reactivate_a_user() -> None:
    admin, customer = create_and_login("admin"), create_and_login("customer")
    as_admin = {"HTTP_AUTHORIZATION": f"Bearer {admin['token']}"}
    path = f"/api/v1/admin/users/{customer['user']['id']}/status"

    off = APIClient().patch(path, {"status": "suspended"}, format="json", **as_admin)
    assert off.status_code == 200
    assert off.json()["data"]["user"]["status"] == "suspended"
    assert me(customer["token"]).status_code == 401
    assert login(customer["user"]["email"]).status_code == 403

    on = APIClient().patch(path, {"status": "active"}, format="json", **as_admin)
    assert on.status_code == 200
    assert on.json()["data"]["user"]["status"] == "active"
    assert login(customer["user"]["email"]).status_code == 200


def test_admins_cannot_suspend_themselves() -> None:
    admin = create_and_login("admin")
    res = APIClient().patch(
        f"/api/v1/admin/users/{admin['user']['id']}/status",
        {"status": "suspended"},
        format="json",
        HTTP_AUTHORIZATION=f"Bearer {admin['token']}",
    )
    assert res.status_code == 400
    assert "cannot suspend your own account" in res.json()["message"].lower()


def test_invalid_ids_are_422() -> None:
    admin = create_and_login("admin")
    res = APIClient().patch(
        "/api/v1/admin/users/not-an-id/status",
        {"status": "suspended"},
        format="json",
        HTTP_AUTHORIZATION=f"Bearer {admin['token']}",
    )
    assert res.status_code == 422
    assert res.json()["error"]["details"] == [{"field": "id", "message": "Invalid id"}]
