import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { ROLES } from "../config/roles.js";
import { DOCUMENT_KINDS as K, DOCUMENT_STATUS, KycDocument, PayoutAccount } from "../models/kyc-document.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { ApiError } from "../utils/api-error.js";
import { encrypt, last4 } from "../utils/field-crypto.js";
import { stripMetadata } from "../utils/image-metadata.js";
import { notify } from "./notification.service.js";
import { detectImageType } from "./upload.service.js";

/**
 * Partner verification (same rules as backend-django/apps/kyc): documents in private storage,
 * the payout bank account, the checklist each partner type needs, and admin review.
 */
export const LABELS = {
  [K.FSSAI_LICENCE]: "FSSAI licence",
  [K.GST_CERTIFICATE]: "GST certificate",
  [K.PAN_CARD]: "PAN card",
  [K.CANCELLED_CHEQUE]: "Cancelled cheque",
  [K.DRIVING_LICENCE]: "Driving licence",
  [K.VEHICLE_RC]: "Vehicle registration (RC)",
  [K.ID_PROOF]: "Identity proof (Aadhaar, voter ID or passport)",
};
// The number printed on the document, when it has one (stored encrypted).
const NUMBER_RULES = {
  [K.FSSAI_LICENCE]: [/^\d{14}$/, "An FSSAI number has 14 digits"],
  [K.GST_CERTIFICATE]: [/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid 15-character GSTIN"],
  [K.PAN_CARD]: [/^[A-Z]{5}\d{4}[A-Z]$/, "Enter a valid PAN, e.g. ABCDE1234F"],
  [K.DRIVING_LICENCE]: [/^[A-Z0-9-]{8,20}$/, "Enter the licence number"],
  [K.VEHICLE_RC]: [/^[A-Z0-9-]{6,15}$/, "Enter the registration number"],
  [K.ID_PROOF]: [/^[A-Z0-9]{6,16}$/, "Enter the ID number"],
};
export const KINDS_FOR = {
  [ROLES.RESTAURANT]: [K.FSSAI_LICENCE, K.GST_CERTIFICATE, K.PAN_CARD, K.CANCELLED_CHEQUE],
  [ROLES.DELIVERY]: [K.DRIVING_LICENCE, K.VEHICLE_RC, K.ID_PROOF],
};
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_NUMBER = /^\d{9,18}$/;
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const CONTENT_TYPES = { pdf: "application/pdf", jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

// --- private storage ------------------------------------------------------------------------------

const dir = () => path.resolve(env.privateUploadDir, "kyc");
export const pathOf = (name) => path.join(dir(), path.basename(name)); // never outside the folder

async function saveFile(data) {
  if (data.length > MAX_DOCUMENT_BYTES)
    throw new ApiError(413, "Documents must be 5 MB or smaller", { code: "LIMIT_FILE_SIZE" });
  const kind = data.subarray(0, 5).toString("latin1") === "%PDF-" ? "pdf" : detectImageType(data);
  if (!kind) throw new ApiError(415, "Upload a PDF, JPEG, PNG or WebP file", { code: "UNSUPPORTED_MEDIA_TYPE" });
  let body = data;
  if (kind !== "pdf") {
    try {
      body = stripMetadata(data, kind);
    } catch {
      throw new ApiError(415, "This file is damaged. Try another one.", { code: "UNSUPPORTED_MEDIA_TYPE" });
    }
  }
  const name = `${crypto.randomUUID()}.${kind}`;
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(pathOf(name), body, { flag: "wx" });
  return { name, contentType: CONTENT_TYPES[kind], size: body.length };
}

const removeFile = (name) => fs.rm(pathOf(name), { force: true });

// --- checklist and output --------------------------------------------------------------------------

/** What this partner must upload. GST only for GST-registered restaurants. */
export async function requiredKinds(user) {
  if (user.role === ROLES.RESTAURANT) {
    const gst = await Restaurant.exists({ owner: user._id, gstRegistered: true });
    return KINDS_FOR[ROLES.RESTAURANT].filter((k) => k !== K.GST_CERTIFICATE || gst);
  }
  return KINDS_FOR[user.role] ?? [];
}

export const documentJson = (d) => ({
  id: String(d._id),
  kind: d.kind,
  label: LABELS[d.kind],
  numberLast4: d.numberLast4 || null,
  contentType: d.contentType,
  size: d.size,
  status: d.status,
  reviewNote: d.reviewNote || null,
  uploadedAt: d.updatedAt,
  reviewedAt: d.reviewedAt,
});

const payoutJson = (a) =>
  a && { holderName: a.holderName, accountLast4: a.accountLast4, ifsc: a.ifsc, bankName: a.bankName || null, updatedAt: a.updatedAt };

/** Documents, bank account and the checklist (`complete`: everything required is approved). */
export async function summary(user) {
  const [docs, account, required] = await Promise.all([
    KycDocument.find({ user: user._id }).sort({ createdAt: 1 }),
    PayoutAccount.findOne({ user: user._id }),
    requiredKinds(user),
  ]);
  const byKind = new Map(docs.map((d) => [d.kind, d]));
  const checklist = required.map((kind) => ({ kind, label: LABELS[kind], status: byKind.get(kind)?.status ?? null }));
  return {
    documents: docs.map(documentJson),
    allowedKinds: (KINDS_FOR[user.role] ?? []).map((kind) => ({ kind, label: LABELS[kind] })),
    checklist,
    payoutAccount: payoutJson(account) ?? null,
    complete: Boolean(account) && checklist.every((i) => i.status === DOCUMENT_STATUS.APPROVED),
  };
}

/** What still stops approval, in words. */
export async function missing(user) {
  const s = await summary(user);
  const gaps = s.checklist
    .filter((i) => i.status !== DOCUMENT_STATUS.APPROVED)
    .map((i) => `${i.label} (${i.status ?? "not uploaded"})`);
  if (!s.payoutAccount) gaps.push("Bank account");
  return gaps;
}

// --- partner --------------------------------------------------------------------------------------

export async function upload(user, kind, data, rawNumber = "") {
  if (!(KINDS_FOR[user.role] ?? []).includes(kind))
    throw ApiError.badRequest("This document is not needed for your account");
  const number = rawNumber.trim().toUpperCase();
  const rule = NUMBER_RULES[kind];
  if (rule && !rule[0].test(number)) throw ApiError.badRequest(rule[1], [{ field: "number", message: rule[1] }]);
  const file = await saveFile(data);
  const old = await KycDocument.findOne({ user: user._id, kind });
  const doc = await KycDocument.findOneAndUpdate(
    { user: user._id, kind },
    {
      fileName: file.name,
      contentType: file.contentType,
      size: file.size,
      numberEncrypted: number ? encrypt(number) : "",
      numberLast4: number ? last4(number) : "",
      status: DOCUMENT_STATUS.PENDING,
      reviewNote: "",
      reviewedAt: null,
      reviewedBy: null,
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  if (old) await removeFile(old.fileName);
  return doc;
}

export async function remove(user, id) {
  const doc = await ownDocument(user, id);
  if (doc.status === DOCUMENT_STATUS.APPROVED)
    throw ApiError.conflict("Approved documents cannot be removed. Upload a new one to replace it.");
  await doc.deleteOne();
  await removeFile(doc.fileName);
}

export async function ownDocument(user, id) {
  const doc = await KycDocument.findOne({ _id: id, user: user._id });
  if (!doc) throw ApiError.notFound("Document not found");
  return doc;
}

export async function setPayoutAccount(user, { holderName, accountNumber, ifsc, bankName }) {
  const number = accountNumber.trim();
  const code = ifsc.trim().toUpperCase();
  if (!ACCOUNT_NUMBER.test(number))
    throw ApiError.badRequest("Enter a valid account number", [{ field: "accountNumber", message: "9 to 18 digits" }]);
  if (!IFSC.test(code)) throw ApiError.badRequest("Enter a valid IFSC", [{ field: "ifsc", message: "e.g. HDFC0001234" }]);
  await PayoutAccount.findOneAndUpdate(
    { user: user._id },
    { holderName: holderName.trim(), accountNumberEncrypted: encrypt(number), accountLast4: last4(number), ifsc: code, bankName: (bankName ?? "").trim() },
    { upsert: true },
  );
}

// --- admin ----------------------------------------------------------------------------------------

export async function documentForAdmin(id) {
  const doc = await KycDocument.findById(id).populate("user", "role");
  if (!doc) throw ApiError.notFound("Document not found");
  return doc;
}

export async function review(doc, status, note, adminId) {
  if (status === DOCUMENT_STATUS.REJECTED && !note) throw ApiError.badRequest("Say what is wrong, so the partner can fix it");
  Object.assign(doc, {
    status,
    reviewNote: status === DOCUMENT_STATUS.REJECTED ? note : "",
    reviewedAt: new Date(),
    reviewedBy: adminId,
  });
  await doc.save();
  if (status === DOCUMENT_STATUS.REJECTED)
    await notify(doc.user._id, {
      type: "kyc.document_rejected",
      title: `Please upload your ${LABELS[doc.kind]} again`,
      body: note,
      link: doc.user.role === ROLES.RESTAURANT ? "/restaurant/verification" : "/delivery/verification",
    });
  return doc;
}
