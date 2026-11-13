"""
Partner verification (Node: services/kyc.service.js): documents, the payout bank account, the
checklist of what each partner type needs, and admin review.
"""

import re
import uuid
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.notifications.services import notify
from apps.rbac.roles import Role
from common import crypto
from common.api import ApiError

from . import storage
from .models import DocumentKind, DocumentStatus, KycDocument, PayoutAccount

K = DocumentKind
LABELS: dict[str, str] = {
    K.FSSAI_LICENCE: "FSSAI licence",
    K.GST_CERTIFICATE: "GST certificate",
    K.PAN_CARD: "PAN card",
    K.CANCELLED_CHEQUE: "Cancelled cheque",
    K.DRIVING_LICENCE: "Driving licence",
    K.VEHICLE_RC: "Vehicle registration (RC)",
    K.ID_PROOF: "Identity proof (Aadhaar, voter ID or passport)",
}
# The number printed on the document, when it has one (stored encrypted).
NUMBER_RULES: dict[str, tuple[re.Pattern[str], str]] = {
    K.FSSAI_LICENCE: (re.compile(r"^\d{14}$"), "An FSSAI number has 14 digits"),
    K.GST_CERTIFICATE: (
        re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$"),
        "Enter a valid 15-character GSTIN",
    ),
    K.PAN_CARD: (re.compile(r"^[A-Z]{5}\d{4}[A-Z]$"), "Enter a valid PAN, e.g. ABCDE1234F"),
    K.DRIVING_LICENCE: (re.compile(r"^[A-Z0-9-]{8,20}$"), "Enter the licence number"),
    K.VEHICLE_RC: (re.compile(r"^[A-Z0-9-]{6,15}$"), "Enter the registration number"),
    K.ID_PROOF: (re.compile(r"^[A-Z0-9]{6,16}$"), "Enter the ID number"),
}
KINDS_FOR: dict[str, tuple[str, ...]] = {
    Role.RESTAURANT: (K.FSSAI_LICENCE, K.GST_CERTIFICATE, K.PAN_CARD, K.CANCELLED_CHEQUE),
    Role.DELIVERY: (K.DRIVING_LICENCE, K.VEHICLE_RC, K.ID_PROOF),
}
IFSC = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")
ACCOUNT_NUMBER = re.compile(r"^\d{9,18}$")


def required_kinds(user: User) -> list[str]:
    """What this partner must upload. GST only for GST-registered restaurants."""
    if user.role == Role.RESTAURANT:
        from apps.restaurants.models import Restaurant

        gst = Restaurant.objects.filter(owner=user, gst_registered=True).exists()
        return [k for k in KINDS_FOR[Role.RESTAURANT] if k != K.GST_CERTIFICATE or gst]
    return list(KINDS_FOR.get(user.role, ()))


# --- output ---------------------------------------------------------------------------------------


def document_json(doc: KycDocument) -> dict[str, Any]:
    return {
        "id": str(doc.pk),
        "kind": doc.kind,
        "label": LABELS[doc.kind],
        "number_last4": doc.number_last4 or None,
        "content_type": doc.content_type,
        "size": doc.size,
        "status": doc.status,
        "review_note": doc.review_note or None,
        "uploaded_at": doc.updated_at,
        "reviewed_at": doc.reviewed_at,
    }


def payout_json(account: PayoutAccount | None) -> dict[str, Any] | None:
    if account is None:
        return None
    return {
        "holder_name": account.holder_name,
        "account_last4": account.account_last4,
        "ifsc": account.ifsc,
        "bank_name": account.bank_name or None,
        "updated_at": account.updated_at,
    }


def summary(user: User) -> dict[str, Any]:
    """Documents, bank account and the checklist (`complete`: everything required is approved)."""
    docs = {d.kind: d for d in KycDocument.objects.filter(user=user)}
    required = required_kinds(user)
    account = PayoutAccount.objects.filter(user=user).first()
    checklist = [
        {"kind": k, "label": LABELS[k], "status": docs[k].status if k in docs else None}
        for k in required
    ]
    return {
        "documents": [document_json(d) for d in sorted(docs.values(), key=lambda d: d.created_at)],
        "allowed_kinds": [{"kind": k, "label": LABELS[k]} for k in KINDS_FOR.get(user.role, ())],
        "checklist": checklist,
        "payout_account": payout_json(account),
        "complete": account is not None
        and all(item["status"] == DocumentStatus.APPROVED for item in checklist),
    }


def missing(user: User) -> list[str]:
    """What still stops approval, in words."""
    s = summary(user)
    gaps = [
        f"{i['label']} ({i['status'] or 'not uploaded'})"
        for i in s["checklist"]
        if i["status"] != DocumentStatus.APPROVED
    ]
    if s["payout_account"] is None:
        gaps.append("Bank account")
    return gaps


# --- partner --------------------------------------------------------------------------------------


def upload(user: User, kind: str, data: bytes, number: str) -> KycDocument:
    if kind not in KINDS_FOR.get(user.role, ()):
        raise ApiError.bad_request("This document is not needed for your account")
    number = number.strip().upper()
    rule = NUMBER_RULES.get(kind)
    if rule and not rule[0].match(number):
        raise ApiError.bad_request(rule[1], [{"field": "number", "message": rule[1]}])
    name, content_type = storage.save(data)
    with transaction.atomic():
        old = KycDocument.objects.select_for_update().filter(user=user, kind=kind).first()
        doc = old or KycDocument(user=user, kind=kind)
        previous_file = old.file_name if old else None
        doc.file_name, doc.content_type, doc.size = name, content_type, len(data)
        doc.number_encrypted = crypto.encrypt(number) if number else ""
        doc.number_last4 = crypto.last4(number) if number else ""
        doc.status, doc.review_note, doc.reviewed_at, doc.reviewed_by = (
            DocumentStatus.PENDING,
            "",
            None,
            None,
        )
        doc.save()
    if previous_file:
        transaction.on_commit(lambda: storage.delete(previous_file))
    return doc


def remove(user: User, doc_id: uuid.UUID) -> None:
    doc = KycDocument.objects.filter(pk=doc_id, user=user).first()
    if doc is None:
        raise ApiError.not_found("Document not found")
    if doc.status == DocumentStatus.APPROVED:
        raise ApiError.conflict(
            "Approved documents cannot be removed. Upload a new one to replace it."
        )
    doc.delete()
    transaction.on_commit(lambda: storage.delete(doc.file_name))


def set_payout_account(user: User, data: dict[str, Any]) -> PayoutAccount:
    number, ifsc = data["account_number"].strip(), data["ifsc"].strip().upper()
    if not ACCOUNT_NUMBER.match(number):
        raise ApiError.bad_request(
            "Enter a valid account number",
            [{"field": "accountNumber", "message": "9 to 18 digits"}],
        )
    if not IFSC.match(ifsc):
        raise ApiError.bad_request(
            "Enter a valid IFSC", [{"field": "ifsc", "message": "e.g. HDFC0001234"}]
        )
    account, _ = PayoutAccount.objects.update_or_create(
        user=user,
        defaults={
            "holder_name": data["holder_name"].strip(),
            "account_number_encrypted": crypto.encrypt(number),
            "account_last4": crypto.last4(number),
            "ifsc": ifsc,
            "bank_name": (data.get("bank_name") or "").strip(),
        },
    )
    return account


def own_document(user: User, doc_id: uuid.UUID) -> KycDocument:
    doc = KycDocument.objects.filter(pk=doc_id, user=user).first()
    if doc is None:
        raise ApiError.not_found("Document not found")
    return doc


# --- admin ----------------------------------------------------------------------------------------


def review(doc_id: uuid.UUID, status: str, note: str, admin: User) -> KycDocument:
    if status == DocumentStatus.REJECTED and not note:
        raise ApiError.bad_request("Say what is wrong, so the partner can fix it")
    doc = KycDocument.objects.select_related("user").filter(pk=doc_id).first()
    if doc is None:
        raise ApiError.not_found("Document not found")
    doc.status, doc.review_note = status, note if status == DocumentStatus.REJECTED else ""
    doc.reviewed_at, doc.reviewed_by = timezone.now(), admin
    doc.save(update_fields=["status", "review_note", "reviewed_at", "reviewed_by", "updated_at"])
    if status == DocumentStatus.REJECTED:
        link = (
            "/restaurant/verification"
            if doc.user.role == Role.RESTAURANT
            else "/delivery/verification"
        )
        notify(
            doc.user_id,
            type="kyc.document_rejected",
            title=f"Please upload your {LABELS[doc.kind]} again",
            body=note,
            link=link,
        )
    return doc


def document_for_admin(doc_id: uuid.UUID) -> KycDocument:
    doc = KycDocument.objects.select_related("user").filter(pk=doc_id).first()
    if doc is None:
        raise ApiError.not_found("Document not found")
    return doc
