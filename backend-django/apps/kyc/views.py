"""
/kyc (restaurant partners and riders: their own documents and bank account) and /admin/kyc
(review). Node: routes/kyc.routes.js. Document files are only ever sent to their owner or to an
admin who reviews that kind of partner, and every admin view is audited.
"""

from typing import Any

from django.http import FileResponse
from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import BasePermission
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from apps.accounts.models import User
from apps.audit.services import audited
from apps.rbac.roles import Permission, Role, has_permission
from common.api import ApiError, ok
from common.permissions import role_required
from common.schema import envelope, errors
from common.throttling import rate_limit
from common.validation import parse_id, validated

from . import services, storage
from .models import DocumentKind, DocumentStatus, KycDocument

PARTNER = [role_required(Role.RESTAURANT, Role.DELIVERY)]
SUMMARY = envelope("KycSummary")
DOCUMENT = envelope("KycDocumentResponse")
REMOVED = envelope("KycDocumentRemoved")
UploadLimit = rate_limit("IMAGE_UPLOAD_RATE_LIMIT", "Too many uploads. Try again later.")
# Which admin permission reviews which partner type.
REVIEWER = {Role.RESTAURANT: Permission.RESTAURANTS_MANAGE, Role.DELIVERY: Permission.RIDERS_MANAGE}


class DocumentInput(serializers.Serializer):
    kind = serializers.ChoiceField(
        choices=DocumentKind.values, error_messages={"invalid_choice": "Choose a document type"}
    )
    number = serializers.CharField(required=False, allow_blank=True, max_length=30, default="")


class PayoutAccountInput(serializers.Serializer):
    holder_name = serializers.CharField(min_length=2, max_length=100)
    account_number = serializers.CharField(max_length=30)
    ifsc = serializers.CharField(max_length=11)
    bank_name = serializers.CharField(required=False, allow_blank=True, max_length=80)


class ReviewInput(serializers.Serializer):
    status = serializers.ChoiceField(choices=[DocumentStatus.APPROVED, DocumentStatus.REJECTED])
    note = serializers.CharField(required=False, allow_blank=True, max_length=500, default="")


def file_response(doc: KycDocument) -> FileResponse:
    path = storage.path_of(doc.file_name)
    if not path.is_file():
        raise ApiError.not_found("The file is missing. Ask for it to be uploaded again.")
    response = FileResponse(path.open("rb"), content_type=doc.content_type)
    extension = doc.file_name.rsplit(".", 1)[1]
    response["Content-Disposition"] = f'inline; filename="{doc.kind}.{extension}"'
    response["Cache-Control"] = "private, no-store"
    response["X-Content-Type-Options"] = "nosniff"
    return response


# --- partner --------------------------------------------------------------------------------------


class MyKycView(APIView):
    permission_classes = PARTNER

    @extend_schema(tags=["KYC"], responses={200: SUMMARY, **errors(401, 403)})
    def get(self, request: Request) -> Response:
        return ok(services.summary(current_user(request)))


class MyDocumentsView(APIView):
    permission_classes = PARTNER
    parser_classes = [MultiPartParser]
    throttle_classes = [UploadLimit]

    @extend_schema(
        tags=["KYC"],
        request={
            "multipart/form-data": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string"},
                    "number": {"type": "string"},
                    "file": {"type": "string", "format": "binary"},
                },
            }
        },
        responses={201: DOCUMENT, **errors(400, 401, 403, 413, 415, 422, 429)},
    )
    def post(self, request: Request) -> Response:
        data = validated(DocumentInput, request.data)
        upload = request.FILES.get("file")
        if upload is None:
            raise ApiError.bad_request(
                "Choose a file", [{"field": "file", "message": "Choose a file"}]
            )
        doc = services.upload(current_user(request), data["kind"], upload.read(), data["number"])
        return ok(
            {"document": services.document_json(doc)}, message="Document uploaded", status=201
        )


class MyDocumentView(APIView):
    permission_classes = PARTNER

    @extend_schema(tags=["KYC"], responses={200: REMOVED, **errors(401, 403, 404, 409)})
    def delete(self, request: Request, id: str) -> Response:
        services.remove(current_user(request), parse_id(id))
        return ok(message="Document removed")


class MyDocumentFileView(APIView):
    permission_classes = PARTNER

    @extend_schema(
        tags=["KYC"], responses={(200, "application/octet-stream"): bytes, **errors(401, 403, 404)}
    )
    def get(self, request: Request, id: str) -> FileResponse:
        return file_response(services.own_document(current_user(request), parse_id(id)))


class MyPayoutAccountView(APIView):
    permission_classes = PARTNER

    @extend_schema(
        tags=["KYC"],
        request=PayoutAccountInput,
        responses={200: SUMMARY, **errors(400, 401, 403, 422)},
    )
    def put(self, request: Request) -> Response:
        user = current_user(request)
        services.set_payout_account(user, validated(PayoutAccountInput, request.data))
        return ok(services.summary(user), message="Bank account saved")


# --- admin ----------------------------------------------------------------------------------------


class IsKycReviewer(BasePermission):
    """Reviews restaurants or riders; each request then checks the partner type it touches."""

    def has_permission(self, request: Request, view: Any) -> bool:
        role = getattr(getattr(request, "user", None), "role", None)
        return any(has_permission(role, p) for p in REVIEWER.values())


def _reviewable(admin: User, partner: User) -> None:
    permission = REVIEWER.get(Role(partner.role)) if partner.role in REVIEWER else None
    if permission is None or not has_permission(admin.role, permission):
        raise ApiError.not_found("Not found")


class AdminPartnerKycView(APIView):
    permission_classes = [IsKycReviewer]

    @extend_schema(tags=["Admin: KYC"], responses={200: SUMMARY, **errors(401, 403, 404)})
    def get(self, request: Request, id: str) -> Response:
        partner = User.objects.filter(pk=parse_id(id)).first()
        if partner is None:
            raise ApiError.not_found("Not found")
        _reviewable(current_user(request), partner)
        return ok(services.summary(partner))


class AdminDocumentView(APIView):
    permission_classes = [IsKycReviewer]

    @extend_schema(
        tags=["Admin: KYC"],
        request=ReviewInput,
        responses={200: DOCUMENT, **errors(400, 401, 403, 404, 422)},
    )
    @audited(
        "kyc.document.review",
        "kyc_document",
        lambda req: f"Marked a document {req.data.get('status')}",
    )
    def patch(self, request: Request, id: str) -> Response:
        admin = current_user(request)
        _reviewable(admin, services.document_for_admin(parse_id(id)).user)
        data = validated(ReviewInput, request.data)
        doc = services.review(parse_id(id), data["status"], data["note"].strip(), admin)
        return ok({"document": services.document_json(doc)}, message="Document reviewed")


class AdminDocumentFileView(APIView):
    permission_classes = [IsKycReviewer]

    @extend_schema(
        tags=["Admin: KYC"],
        responses={(200, "application/octet-stream"): bytes, **errors(401, 403, 404)},
    )
    @audited("kyc.document.view", "kyc_document", lambda req: "Viewed a KYC document")
    def get(self, request: Request, id: str) -> FileResponse:
        doc = services.document_for_admin(parse_id(id))
        _reviewable(current_user(request), doc.user)
        return file_response(doc)
