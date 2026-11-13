"""Partner verification: documents, bank account, admin review, and restaurant approval rules."""

import io
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from rest_framework.test import APIClient

from apps.accounts.tokens import sign_access_token
from apps.audit.models import AuditLog
from apps.kyc.models import KycDocument, PayoutAccount
from apps.notifications.models import Notification
from apps.rbac.roles import Role
from apps.restaurants.models import Restaurant
from apps.restaurants.presenters import is_open_now
from common import crypto
from tests.factories import restaurant, user

pytestmark = pytest.mark.django_db
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
FSSAI = "12345678901234"


def client_of(u: Any) -> APIClient:
    c = APIClient()
    c.credentials(HTTP_AUTHORIZATION=f"Bearer {sign_access_token(u)}")
    return c


def upload(c: APIClient, kind: str, number: str = "", data: bytes = PDF) -> Any:
    f = io.BytesIO(data)
    f.name = "doc.pdf"
    return c.post(
        "/api/v1/kyc/documents", {"kind": kind, "number": number, "file": f}, format="multipart"
    )


@pytest.fixture
def kitchen() -> Restaurant:
    return restaurant(status="pending")


def test_partners_upload_documents_that_only_they_and_reviewers_can_read(
    kitchen: Restaurant,
) -> None:
    owner = client_of(kitchen.owner)
    res = upload(owner, "fssai_licence", FSSAI)
    assert res.status_code == 201, res.json()
    doc = res.json()["data"]["document"]
    assert doc["numberLast4"] == "1234"
    assert doc["status"] == "pending"
    stored = KycDocument.objects.get()
    assert FSSAI not in stored.number_encrypted
    assert crypto.decrypt(stored.number_encrypted) == FSSAI

    summary = owner.get("/api/v1/kyc").json()["data"]
    assert [i["kind"] for i in summary["checklist"]] == [
        "fssai_licence",
        "pan_card",
        "cancelled_cheque",
    ]
    assert summary["complete"] is False
    file = owner.get(f"/api/v1/kyc/documents/{doc['id']}/file")
    assert file.status_code == 200
    assert b"".join(file.streaming_content) == PDF
    assert file["Cache-Control"] == "private, no-store"

    stranger = client_of(restaurant().owner)
    assert stranger.get(f"/api/v1/kyc/documents/{doc['id']}/file").status_code == 404
    ops = client_of(user(Role.OPERATIONS_ADMIN))  # restaurants:manage
    assert ops.get(f"/api/v1/admin/kyc/documents/{doc['id']}/file").status_code == 200
    assert AuditLog.objects.filter(action="kyc.document.view").count() == 1
    assert (
        client_of(user(Role.FINANCE_ADMIN))
        .get(f"/api/v1/admin/kyc/documents/{doc['id']}/file")
        .status_code
        == 403
    )


@pytest.mark.parametrize(
    ("kind", "number", "data", "status"),
    [
        ("fssai_licence", FSSAI, b"plain text", 415),
        ("fssai_licence", "123", PDF, 400),  # not 14 digits
        ("driving_licence", "DL0420110012345", PDF, 400),  # a rider's document
        ("fssai_licence", FSSAI, PDF + b"x" * (5 * 1024 * 1024), 413),
    ],
)
def test_bad_uploads_are_refused(
    kitchen: Restaurant, kind: str, number: str, data: bytes, status: int
) -> None:
    assert upload(client_of(kitchen.owner), kind, number, data).status_code == status
    assert not KycDocument.objects.exists()


def test_uploading_again_replaces_the_document_and_approved_ones_stay(kitchen: Restaurant) -> None:
    owner = client_of(kitchen.owner)
    first = upload(owner, "pan_card", "ABCDE1234F").json()["data"]["document"]
    ops = client_of(user(Role.OPERATIONS_ADMIN))
    assert (
        ops.patch(
            f"/api/v1/admin/kyc/documents/{first['id']}", {"status": "approved"}, format="json"
        ).status_code
        == 200
    )
    assert owner.delete(f"/api/v1/kyc/documents/{first['id']}").status_code == 409
    again = upload(owner, "pan_card", "ABCDE9999F").json()["data"]["document"]
    assert again["id"] == first["id"]
    assert again["status"] == "pending"
    assert KycDocument.objects.count() == 1


def test_rejections_need_a_note_and_tell_the_partner(kitchen: Restaurant) -> None:
    doc = upload(client_of(kitchen.owner), "cancelled_cheque").json()["data"]["document"]
    ops = client_of(user(Role.OPERATIONS_ADMIN))
    url = f"/api/v1/admin/kyc/documents/{doc['id']}"
    assert ops.patch(url, {"status": "rejected"}, format="json").status_code == 400
    res = ops.patch(url, {"status": "rejected", "note": "The cheque is blurred"}, format="json")
    assert res.json()["data"]["document"]["reviewNote"] == "The cheque is blurred"
    note = Notification.objects.get(user=kitchen.owner, type="kyc.document_rejected")
    assert note.link == "/restaurant/verification"


def test_the_bank_account_is_masked_and_encrypted(kitchen: Restaurant) -> None:
    owner = client_of(kitchen.owner)
    body = {
        "holderName": "Spice Route Foods",
        "accountNumber": "123456789012",
        "ifsc": "HDFC0001234",
    }
    assert (
        owner.put("/api/v1/kyc/payout-account", {**body, "ifsc": "BAD"}, format="json").status_code
        == 400
    )
    res = owner.put("/api/v1/kyc/payout-account", body, format="json")
    assert res.json()["data"]["payoutAccount"]["accountLast4"] == "9012"
    assert "accountNumber" not in res.json()["data"]["payoutAccount"]
    stored = PayoutAccount.objects.get()
    assert "123456789012" not in stored.account_number_encrypted


def complete_kyc(r: Restaurant) -> None:
    owner, ops = client_of(r.owner), client_of(user(Role.OPERATIONS_ADMIN))
    for kind, number in (
        ("fssai_licence", FSSAI),
        ("pan_card", "ABCDE1234F"),
        ("cancelled_cheque", ""),
    ):
        doc = upload(owner, kind, number).json()["data"]["document"]
        ops.patch(f"/api/v1/admin/kyc/documents/{doc['id']}", {"status": "approved"}, format="json")
    owner.put(
        "/api/v1/kyc/payout-account",
        {"holderName": "Owner", "accountNumber": "123456789012", "ifsc": "HDFC0001234"},
        format="json",
    )


def test_restaurants_go_live_only_after_verification(kitchen: Restaurant, settings: Any) -> None:
    settings.RESTAURANT_KYC_REQUIRED = True
    admin = client_of(user(Role.ADMIN))
    status = lambda s, reason="": admin.patch(  # noqa: E731
        f"/api/v1/admin/restaurants/{kitchen.pk}/status",
        {"status": s, "reason": reason},
        format="json",
    )
    blocked = status("approved")
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "KYC_INCOMPLETE"
    assert "FSSAI number" in blocked.json()["message"]
    assert "Bank account" in blocked.json()["message"]

    # Documents needed -> the owner fixes them and resubmits -> approved.
    assert status("resubmission_requested").status_code == 400  # needs a reason
    assert status("resubmission_requested", "Upload your FSSAI licence").status_code == 200
    owner = client_of(kitchen.owner)
    Restaurant.objects.filter(pk=kitchen.pk).update(fssai_number=FSSAI)
    complete_kyc(kitchen)
    assert (
        owner.post("/api/v1/my/restaurant/resubmit").json()["data"]["restaurant"]["status"]
        == "pending"
    )
    assert owner.post("/api/v1/my/restaurant/resubmit").status_code == 409
    assert status("approved").status_code == 200


def test_gst_registered_restaurants_need_a_gstin_and_its_certificate(kitchen: Restaurant) -> None:
    owner = client_of(kitchen.owner)
    bad = owner.patch("/api/v1/my/restaurant", {"gstRegistered": True}, format="json")
    assert bad.status_code == 422
    ok = owner.patch(
        "/api/v1/my/restaurant", {"gstRegistered": True, "gstin": "29ABCDE1234F1Z5"}, format="json"
    )
    assert ok.status_code == 200, ok.json()
    kinds = [i["kind"] for i in owner.get("/api/v1/kyc").json()["data"]["checklist"]]
    assert "gst_certificate" in kinds


def test_weekly_hours_decide_when_the_restaurant_is_open(kitchen: Restaurant) -> None:
    owner = client_of(kitchen.owner)
    hours = {d: [{"open": "09:00", "close": "22:00"}] for d in ("mon", "tue", "wed", "thu", "fri")}
    hours.update(sat=[{"open": "18:00", "close": "02:00"}], sun=[])
    res = owner.patch("/api/v1/my/restaurant", {"weeklyHours": hours}, format="json")
    assert res.status_code == 200, res.json()
    assert (
        owner.patch(
            "/api/v1/my/restaurant", {"weeklyHours": {"mon": [{"open": "9"}]}}, format="json"
        ).status_code
        == 422
    )
    r = Restaurant.objects.get(pk=kitchen.pk)
    at = lambda day, hm: datetime(2026, 11, day, *hm, tzinfo=ZoneInfo("Asia/Kolkata"))  # noqa: E731
    assert is_open_now(r, at(16, (10, 0)))  # Monday
    assert not is_open_now(r, at(16, (23, 0)))
    assert is_open_now(r, at(21, (23, 30)))  # Saturday night
    assert is_open_now(r, at(22, (1, 30)))  # Sunday, still Saturday's late slot
    assert not is_open_now(r, at(22, (12, 0)))  # Sunday closed
