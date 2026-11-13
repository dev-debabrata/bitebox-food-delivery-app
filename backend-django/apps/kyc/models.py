"""
Partner verification (Node: models/kyc-document.model.js, payout-account.model.js): the documents
a restaurant or rider uploads, and the bank account BiteBox pays them into. Document files live
in private storage (apps/kyc/storage.py); numbers are encrypted (common/crypto.py).
"""

from django.conf import settings
from django.db import models

from common.models import BaseModel, one_of


class DocumentKind(models.TextChoices):
    # Restaurants
    FSSAI_LICENCE = "fssai_licence"
    GST_CERTIFICATE = "gst_certificate"
    PAN_CARD = "pan_card"
    CANCELLED_CHEQUE = "cancelled_cheque"
    # Riders (Part 3)
    DRIVING_LICENCE = "driving_licence"
    VEHICLE_RC = "vehicle_rc"
    ID_PROOF = "id_proof"


class DocumentStatus(models.TextChoices):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class KycDocument(BaseModel):
    """One document per kind and person; uploading again replaces it and needs a new review."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="kyc_documents"
    )
    kind = models.CharField(max_length=24, choices=DocumentKind.choices)
    number_encrypted = models.TextField(blank=True, default="")
    number_last4 = models.CharField(max_length=4, blank=True, default="")
    file_name = models.CharField(max_length=80)  # in PRIVATE_UPLOAD_DIR/kyc
    content_type = models.CharField(max_length=40)
    size = models.PositiveIntegerField()
    status = models.CharField(
        max_length=10, choices=DocumentStatus.choices, default=DocumentStatus.PENDING
    )
    review_note = models.CharField(max_length=500, blank=True, default="")
    reviewed_at = models.DateTimeField(null=True, blank=True)
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    class Meta:
        db_table = "kyc_documents"
        constraints = [
            models.UniqueConstraint(fields=["user", "kind"], name="kyc_documents_one_per_kind"),
            one_of("kind", DocumentKind, "kyc_documents_kind_valid"),
            one_of("status", DocumentStatus, "kyc_documents_status_valid"),
        ]


class PayoutAccount(BaseModel):
    """Where BiteBox pays a partner. Only the last 4 digits of the account number are shown."""

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="payout_account"
    )
    holder_name = models.CharField(max_length=100)
    account_number_encrypted = models.TextField()
    account_last4 = models.CharField(max_length=4)
    ifsc = models.CharField(max_length=11)
    bank_name = models.CharField(max_length=80, blank=True, default="")

    class Meta:
        db_table = "payout_accounts"
