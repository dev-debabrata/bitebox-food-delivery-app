"""
Port of the Node API's tests/admin-roles.test.js (permissions and admin management). Endpoints
from later phases (orders, finance, support...) join the matrix as they are built.
"""

from typing import Any

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.audit.models import AuditLog
from apps.delivery.models import DeliveryPartner
from tests import factories as make

from .test_auth import create_and_login, login, me

pytestmark = pytest.mark.django_db

ROLES = ["admin", "operations_admin", "finance_admin", "support_admin", "customer"]
NEW = {
    "name": "Nora Ops",
    "email": "nora.ops@example.com",
    "password": "Ops-pass-123",
    "role": "operations_admin",
}


@pytest.fixture(autouse=True)
def _clear_rate_limits() -> None:
    cache.clear()


@pytest.fixture
def as_() -> dict[str, dict[str, Any]]:
    return {role: create_and_login(role) for role in ROLES}


def client(token: str) -> APIClient:
    c = APIClient()
    c.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return c


MATRIX = [
    ("/admin/admins", ["admin"]),
    ("/admin/audit-logs", ["admin"]),
    ("/admin/users", ["admin"]),
]


@pytest.mark.parametrize(("path", "allowed"), MATRIX)
def test_permission_matrix(as_: dict[str, Any], path: str, allowed: list[str]) -> None:
    for role in ROLES:
        res = client(as_[role]["token"]).get(f"/api/v1{path}")
        expected = 200 if role in allowed else 403
        assert res.status_code == expected, f"{role} on {path}: {res.json()['message']}"


def test_users_lists_only_members(as_: dict[str, Any]) -> None:
    admin = client(as_["admin"]["token"])
    roles = {u["role"] for u in admin.get("/api/v1/admin/users?limit=100").json()["data"]["items"]}
    assert roles.isdisjoint({"admin", "operations_admin", "finance_admin", "support_admin"})
    assert admin.get("/api/v1/admin/users?role=finance_admin").status_code == 422
    suspend = admin.patch(
        f"/api/v1/admin/users/{as_['finance_admin']['user']['id']}/status",
        {"status": "suspended"},
        format="json",
    )
    assert suspend.status_code == 400, "admins are managed in Admin management"


def test_out_of_range_paging_is_422(as_: dict[str, Any]) -> None:
    admin = client(as_["admin"]["token"])
    assert admin.get("/api/v1/admin/users?limit=500").status_code == 422
    assert admin.get("/api/v1/admin/users?page=0").status_code == 422


def test_search_finds_by_name_email_or_phone(as_: dict[str, Any]) -> None:
    admin = client(as_["admin"]["token"])
    for term in ("Asha", "customer@bitebox", "9000000002"):
        items = admin.get(f"/api/v1/admin/users?search={term}").json()["data"]["items"]
        assert [u["email"] for u in items] == ["customer@bitebox.test"], term


def test_each_admin_role_gets_its_permissions(as_: dict[str, Any]) -> None:
    assert "admins:manage" in as_["admin"]["user"]["permissions"]
    assert sorted(as_["finance_admin"]["user"]["permissions"]) == [
        "finance:view",
        "payouts:manage",
        "refunds:manage",
    ]
    assert "permissions" not in as_["customer"]["user"]


# --- admin management ---------------------------------------------------------------------------


def test_creates_a_staff_admin_who_can_sign_in(as_: dict[str, Any]) -> None:
    res = client(as_["admin"]["token"]).post("/api/v1/admin/admins", NEW, format="json")
    assert res.status_code == 201, res.json()
    created = res.json()["data"]["user"]
    assert created["role"] == "operations_admin"

    signed_in = login(NEW["email"], NEW["password"])
    assert signed_in.status_code == 200
    assert "orders:manage" in signed_in.json()["data"]["user"]["permissions"]

    entry = AuditLog.objects.get(action="admin.create")
    assert str(entry.admin_id) == as_["admin"]["user"]["id"]
    assert entry.admin_role == "admin"
    assert entry.resource_id == created["id"]
    assert entry.description == "Created Operations admin nora.ops@example.com"


@pytest.mark.parametrize("role", ["admin", "customer"])
def test_never_creates_super_admins_or_customers(as_: dict[str, Any], role: str) -> None:
    res = client(as_["admin"]["token"]).post(
        "/api/v1/admin/admins", {**NEW, "role": role}, format="json"
    )
    assert res.status_code == 422


def test_staff_admins_cannot_manage_admins(as_: dict[str, Any]) -> None:
    res = client(as_["operations_admin"]["token"]).post("/api/v1/admin/admins", NEW, format="json")
    assert res.status_code == 403
    assert not AuditLog.objects.exists()  # refused requests are not audited


def test_role_change_signs_the_admin_out(as_: dict[str, Any]) -> None:
    admin = client(as_["admin"]["token"])
    created = admin.post("/api/v1/admin/admins", NEW, format="json").json()["data"]["user"]
    token = login(NEW["email"], NEW["password"]).json()["data"]["accessToken"]

    res = admin.patch(
        f"/api/v1/admin/admins/{created['id']}", {"role": "finance_admin"}, format="json"
    )
    assert res.status_code == 200
    assert res.json()["data"]["user"]["role"] == "finance_admin"
    assert me(token).status_code == 401, "old session no longer valid"
    assert (
        AuditLog.objects.get(action="admin.update").description
        == "Updated admin; role set to Finance admin"
    )


def test_deactivates_an_admin_and_cannot_edit_own_account(as_: dict[str, Any]) -> None:
    admin = client(as_["admin"]["token"])
    created = admin.post("/api/v1/admin/admins", NEW, format="json").json()["data"]["user"]
    off = admin.patch(
        f"/api/v1/admin/admins/{created['id']}/status", {"status": "suspended"}, format="json"
    )
    assert off.status_code == 200
    assert login(NEW["email"], NEW["password"]).status_code == 403

    own = admin.patch(
        f"/api/v1/admin/admins/{as_['admin']['user']['id']}",
        {"role": "support_admin"},
        format="json",
    )
    assert own.status_code == 400


def test_role_stays_out_of_own_profile_update(as_: dict[str, Any]) -> None:
    res = client(as_["support_admin"]["token"]).patch(
        "/api/v1/auth/me", {"name": "Sana S", "role": "admin"}, format="json"
    )
    assert res.status_code == 200
    assert res.json()["data"]["user"]["role"] == "support_admin"


def test_get_staff_and_audit_log_listing(as_: dict[str, Any]) -> None:
    admin = client(as_["admin"]["token"])
    created = admin.post("/api/v1/admin/admins", NEW, format="json").json()["data"]["user"]
    assert (
        admin.get(f"/api/v1/admin/admins/{created['id']}").json()["data"]["user"]["email"]
        == NEW["email"]
    )
    assert admin.get(f"/api/v1/admin/admins/{as_['customer']['user']['id']}").status_code == 404

    page = admin.get("/api/v1/admin/audit-logs?action=admin.create").json()["data"]
    assert page["pagination"]["total"] == 1
    entry = page["items"][0]
    assert entry["admin"] == {
        "id": as_["admin"]["user"]["id"],
        "name": "BiteBox Admin",
        "email": "admin@bitebox.test",
    }
    assert entry["adminRole"] == "admin"
    assert entry["resourceId"] == created["id"]


# --- riders -------------------------------------------------------------------------------------


def test_a_rider_carrying_an_order_cannot_be_suspended(as_: dict[str, Any]) -> None:
    rider = create_and_login("delivery")
    profile = DeliveryPartner.objects.get(user_id=rider["user"]["id"])
    profile.is_online = True
    profile.active_order = make.order()
    profile.save()

    admin = client(as_["admin"]["token"])
    path = f"/api/v1/admin/users/{rider['user']['id']}/status"
    busy = admin.patch(path, {"status": "suspended"}, format="json")
    assert busy.status_code == 409
    assert busy.json()["error"]["code"] == "DELIVERY_IN_PROGRESS"

    DeliveryPartner.objects.filter(pk=profile.pk).update(active_order=None)
    assert admin.patch(path, {"status": "suspended"}, format="json").status_code == 200
    assert DeliveryPartner.objects.get(pk=profile.pk).is_online is False
