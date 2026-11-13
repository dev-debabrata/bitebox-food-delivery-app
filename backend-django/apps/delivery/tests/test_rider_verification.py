"""Rider registration and verification: documents, bank account, address, and going online."""

import io
from typing import Any

import pytest
from rest_framework.test import APIClient

from apps.accounts.tokens import sign_access_token
from apps.delivery.models import DeliveryPartner
from apps.notifications.models import Notification
from apps.rbac.roles import Role
from tests.factories import user

pytestmark = pytest.mark.django_db
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
DOCS = (
    ("driving_licence", "KA0120230001234"),
    ("vehicle_rc", "KA01AB1234"),
    ("id_proof", "AB1234567"),
)
ADDRESS = {
    "line1": "4 Fictional Lane",
    "city": "Bengaluru",
    "state": "Karnataka",
    "postalCode": "560001",
}


@pytest.fixture(autouse=True)
def required(settings: Any) -> None:
    settings.RIDER_KYC_REQUIRED = True


def client_of(u: Any) -> APIClient:
    c = APIClient()
    c.credentials(HTTP_AUTHORIZATION=f"Bearer {sign_access_token(u)}")
    return c


def go_online(c: APIClient) -> Any:
    return c.patch(
        "/api/v1/delivery/me/availability",
        {"isOnline": True, "latitude": 12.97, "longitude": 77.59},
        format="json",
    )


def verify(admin: APIClient, rider_id: Any, status: str, reason: str = "") -> Any:
    return admin.patch(
        f"/api/v1/admin/delivery-partners/{rider_id}/verification",
        {"status": status, "reason": reason},
        format="json",
    )


def complete(rider: APIClient, ops: APIClient) -> None:
    for kind, number in DOCS:
        f = io.BytesIO(PDF)
        f.name = "doc.pdf"
        doc = rider.post(
            "/api/v1/kyc/documents", {"kind": kind, "number": number, "file": f}, format="multipart"
        )
        assert doc.status_code == 201, doc.json()
        ops.patch(
            f"/api/v1/admin/kyc/documents/{doc.json()['data']['document']['id']}",
            {"status": "approved"},
            format="json",
        )
    rider.put(
        "/api/v1/kyc/payout-account",
        {"holderName": "Ravi Test", "accountNumber": "123456789012", "ifsc": "SBIN0001234"},
        format="json",
    )
    assert (
        rider.patch("/api/v1/delivery/me/details", {"address": ADDRESS}, format="json").status_code
        == 200
    )


def test_new_riders_go_online_only_after_verification() -> None:
    r = user(Role.DELIVERY)
    rider, ops = client_of(r), client_of(user(Role.OPERATIONS_ADMIN))
    rider.put("/api/v1/delivery/me/vehicle", {"vehicleType": "motorbike"}, format="json")
    me = rider.get("/api/v1/delivery/me").json()["data"]["profile"]
    assert me["verification"]["status"] == "pending"
    blocked = go_online(rider)
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "RIDER_NOT_VERIFIED"

    early = verify(ops, r.pk, "approved")
    assert early.status_code == 409
    for gap in (
        "Driving licence",
        "Vehicle registration",
        "Identity proof",
        "Bank account",
        "Address",
    ):
        assert gap in early.json()["message"]
    pending = ops.get("/api/v1/admin/delivery-partners?verification=pending").json()["data"][
        "items"
    ]
    assert [i["id"] for i in pending] == [str(r.pk)]

    complete(rider, ops)
    assert (
        verify(ops, r.pk, "approved").json()["data"]["profile"]["verification"]["status"]
        == "approved"
    )
    assert go_online(rider).status_code == 200
    assert Notification.objects.filter(user=r, type="rider.verified").exists()


def test_asking_for_documents_takes_the_rider_offline_until_they_resubmit() -> None:
    r = user(Role.DELIVERY)
    rider, ops = client_of(r), client_of(user(Role.OPERATIONS_ADMIN))
    rider.put("/api/v1/delivery/me/vehicle", {"vehicleType": "scooter"}, format="json")
    complete(rider, ops)
    verify(ops, r.pk, "approved")
    go_online(rider)
    assert verify(ops, r.pk, "resubmission_requested").status_code == 400  # needs a reason
    asked = verify(ops, r.pk, "resubmission_requested", "Your licence has expired")
    assert asked.status_code == 200
    assert DeliveryPartner.objects.get(user=r).is_online is False
    note = Notification.objects.get(user=r, type="rider.documents_needed")
    assert "licence has expired" in note.body
    assert go_online(rider).status_code == 403

    assert (
        rider.post("/api/v1/delivery/me/resubmit").json()["data"]["profile"]["verification"][
            "status"
        ]
        == "pending"
    )
    assert rider.post("/api/v1/delivery/me/resubmit").status_code == 409
    assert verify(ops, r.pk, "approved").status_code == 200


def test_rider_detail_and_permissions() -> None:
    r = user(Role.DELIVERY)
    ops = client_of(user(Role.OPERATIONS_ADMIN))
    detail = ops.get(f"/api/v1/admin/delivery-partners/{r.pk}").json()["data"]
    assert detail["user"]["id"] == str(r.pk)
    assert detail["profile"]["verification"]["status"] == "pending"
    assert (
        client_of(user(Role.FINANCE_ADMIN))
        .get(f"/api/v1/admin/delivery-partners/{r.pk}")
        .status_code
        == 403
    )
    assert (
        client_of(r)
        .patch("/api/v1/delivery/me/details", {"address": {"city": "x"}}, format="json")
        .status_code
        == 422
    )
