import { Router } from "express";
import { env } from "../config/env.js";
import { authenticate, authorize } from "../middleware/auth.middleware.js";
import { createRateLimiter } from "../middleware/security.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { ROLES } from "../models/user.model.js";
import * as referrals from "../services/referral.service.js";
import { respond } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";
import * as rules from "../validators/rewards.validators.js";

const customerOnly = [authenticate, authorize(ROLES.CUSTOMER)];

/** /api/v1/referrals: refer & earn. */
export const referralsRouter = Router()
  .post(
    "/validate",
    // Public (the sign-up form), so slow down code guessing.
    createRateLimiter({
      windowMs: 15 * 60_000,
      limit: env.isTest ? 1000 : 30,
      message: "Too many attempts. Try again later.",
    }),
    validate(rules.referralCodeRules),
    respond((req) => referrals.validateCode(req.body.code)),
  )
  .get("/me", ...customerOnly, respond((req) => referrals.myReferral(req.user._id)))
  .get(
    "/me/history",
    ...customerOnly,
    validate(rules.referralHistoryRules),
    respond((req) =>
      referrals.myReferralHistory(
        req.user._id,
        req.validatedQuery,
        parsePagination(req.validatedQuery),
      ),
    ),
  );
