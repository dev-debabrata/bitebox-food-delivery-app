import { Router } from "express";
import { body } from "express-validator";
import multer from "multer";
import { env } from "../config/env.js";
import { PERMISSIONS, hasPermission } from "../config/permissions.js";
import { ROLES } from "../config/roles.js";
import { authenticate, authorize, can } from "../middleware/auth.middleware.js";
import { createRateLimiter } from "../middleware/security.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { DOCUMENT_KINDS, DOCUMENT_STATUS } from "../models/kyc-document.model.js";
import { User } from "../models/user.model.js";
import { audited } from "../services/audit.service.js";
import * as kyc from "../services/kyc.service.js";
import { ApiError } from "../utils/api-error.js";
import { respond } from "../utils/api-response.js";
import { mongoIdParam } from "../validators/common.validators.js";

/**
 * /kyc (restaurant partners and riders: their own documents and bank account) and /admin/kyc
 * (review). Same as backend-django/apps/kyc/views.py. Document files are only ever sent to their
 * owner or to an admin who reviews that kind of partner, and every admin view is audited.
 */
const REVIEWER = { [ROLES.RESTAURANT]: PERMISSIONS.RESTAURANTS_MANAGE, [ROLES.DELIVERY]: PERMISSIONS.RIDERS_MANAGE };

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: kyc.MAX_DOCUMENT_BYTES, files: 1 } });
const singleFile = (req, res, next) =>
  upload.single("file")(req, res, (error) => {
    if (error instanceof multer.MulterError)
      return next(
        new ApiError(error.code === "LIMIT_FILE_SIZE" ? 413 : 400, error.code === "LIMIT_FILE_SIZE" ? "Documents must be 5 MB or smaller" : 'Upload one file in the "file" field', { code: error.code }),
      );
    next(error);
  });
const uploadLimit = createRateLimiter({ windowMs: 60 * 60_000, limit: env.isTest ? 1000 : 60, message: "Too many uploads. Try again later." });

function sendFile(res, doc) {
  res.set({
    "Content-Type": doc.contentType,
    "Content-Disposition": `inline; filename="${doc.kind}.${doc.fileName.split(".").pop()}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.sendFile(kyc.pathOf(doc.fileName), (error) => {
    if (error && !res.headersSent) res.status(404).json({ success: false, message: "The file is missing. Ask for it to be uploaded again." });
  });
}

function reviewable(admin, partner) {
  const permission = partner && REVIEWER[partner.role];
  if (!permission || !hasPermission(admin.role, permission)) throw ApiError.notFound("Not found");
}

// --- partner --------------------------------------------------------------------------------------

export const kycRouter = Router()
  .use(authenticate, authorize(ROLES.RESTAURANT, ROLES.DELIVERY))
  .get("/", respond((req) => kyc.summary(req.user)))
  .post(
    "/documents",
    uploadLimit,
    singleFile,
    validate([
      body("kind").isIn(Object.values(DOCUMENT_KINDS)).withMessage("Choose a document type"),
      body("number").optional().isString().isLength({ max: 30 }),
    ]),
    respond(
      async (req) => {
        if (!req.file) throw ApiError.badRequest("Choose a file", [{ field: "file", message: "Choose a file" }]);
        return { document: kyc.documentJson(await kyc.upload(req.user, req.body.kind, req.file.buffer, req.body.number)) };
      },
      "Document uploaded",
      201,
    ),
  )
  .delete("/documents/:id", validate([mongoIdParam()]), respond((req) => kyc.remove(req.user, req.params.id).then(() => null), "Document removed"))
  .get("/documents/:id/file", validate([mongoIdParam()]), async (req, res) => sendFile(res, await kyc.ownDocument(req.user, req.params.id)))
  .put(
    "/payout-account",
    validate([
      body("holderName").isString().trim().isLength({ min: 2, max: 100 }).withMessage("Enter the account holder's name"),
      body("accountNumber").isString().isLength({ max: 30 }),
      body("ifsc").isString().isLength({ max: 11 }),
      body("bankName").optional().isString().isLength({ max: 80 }),
    ]),
    respond(async (req) => {
      await kyc.setPayoutAccount(req.user, req.body);
      return kyc.summary(req.user);
    }, "Bank account saved"),
  );

// --- admin ----------------------------------------------------------------------------------------

export const adminKycRouter = Router()
  .use(authenticate, can(PERMISSIONS.RESTAURANTS_MANAGE, PERMISSIONS.RIDERS_MANAGE))
  .get(
    "/partners/:id",
    validate([mongoIdParam()]),
    respond(async (req) => {
      const partner = await User.findById(req.params.id);
      reviewable(req.user, partner);
      return kyc.summary(partner);
    }),
  )
  .patch(
    "/documents/:id",
    validate([
      mongoIdParam(),
      body("status").isIn([DOCUMENT_STATUS.APPROVED, DOCUMENT_STATUS.REJECTED]).withMessage("Choose approved or rejected"),
      body("note").optional().isString().trim().isLength({ max: 500 }),
    ]),
    audited("kyc.document.review", "kyc_document", (req) => `Marked a document ${req.body.status}`),
    respond(async (req) => {
      const doc = await kyc.documentForAdmin(req.params.id);
      reviewable(req.user, doc.user);
      return { document: kyc.documentJson(await kyc.review(doc, req.body.status, req.body.note ?? "", req.user._id)) };
    }, "Document reviewed"),
  )
  .get(
    "/documents/:id/file",
    validate([mongoIdParam()]),
    audited("kyc.document.view", "kyc_document", () => "Viewed a KYC document"),
    async (req, res) => {
      const doc = await kyc.documentForAdmin(req.params.id);
      reviewable(req.user, doc.user);
      sendFile(res, doc);
    },
  );
