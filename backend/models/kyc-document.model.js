import mongoose from "mongoose";

/**
 * Partner verification (Django apps/kyc): the documents a restaurant or rider uploads, one per
 * kind; uploading again replaces it and needs a new review. Files live in private storage
 * (services/kyc.service.js); the number on the document is encrypted (utils/field-crypto.js).
 */
export const DOCUMENT_KINDS = Object.freeze({
  FSSAI_LICENCE: "fssai_licence",
  GST_CERTIFICATE: "gst_certificate",
  PAN_CARD: "pan_card",
  CANCELLED_CHEQUE: "cancelled_cheque",
  DRIVING_LICENCE: "driving_licence",
  VEHICLE_RC: "vehicle_rc",
  ID_PROOF: "id_proof",
});
export const DOCUMENT_STATUS = Object.freeze({ PENDING: "pending", APPROVED: "approved", REJECTED: "rejected" });

const kycDocumentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: Object.values(DOCUMENT_KINDS), required: true },
    numberEncrypted: { type: String, default: "" },
    numberLast4: { type: String, default: "", maxlength: 4 },
    fileName: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    status: { type: String, enum: Object.values(DOCUMENT_STATUS), default: DOCUMENT_STATUS.PENDING },
    reviewNote: { type: String, default: "", maxlength: 500 },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);
kycDocumentSchema.index({ user: 1, kind: 1 }, { unique: true });

export const KycDocument = mongoose.model("KycDocument", kycDocumentSchema);

/** Where BiteBox pays a partner. Only the last 4 digits of the account number are shown. */
const payoutAccountSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    holderName: { type: String, required: true, trim: true, maxlength: 100 },
    accountNumberEncrypted: { type: String, required: true },
    accountLast4: { type: String, required: true, maxlength: 4 },
    ifsc: { type: String, required: true, maxlength: 11 },
    bankName: { type: String, default: "", maxlength: 80 },
  },
  { timestamps: true },
);

export const PayoutAccount = mongoose.model("PayoutAccount", payoutAccountSchema);
