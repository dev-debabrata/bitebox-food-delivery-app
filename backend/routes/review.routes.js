import { Router } from "express";
import { PERMISSIONS } from "../config/permissions.js";
import { authenticate, authorize, can } from "../middleware/auth.middleware.js";
import { audited } from "../services/audit.service.js";
import { createRateLimiter } from "../middleware/security.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { env } from "../config/env.js";
import { ROLES } from "../models/user.model.js";
import * as moderation from "../services/review-moderation.service.js";
import * as reviews from "../services/review.service.js";
import { respond } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";
import { mongoIdParam } from "../validators/common.validators.js";
import { daysRules } from "../validators/payment.validators.js";
import * as rules from "../validators/review.validators.js";

const page = (req) => parsePagination(req.validatedQuery, { defaultLimit: 10 });
const asReview = (load) => async (req) => ({ review: await load(req) });
const customerOnly = authorize(ROLES.CUSTOMER);

/** /api/v1/reviews: customers write and manage their reviews; customers and the reviewed party report them. */
export const reviewsRouter = Router()
  .use(authenticate)
  .post(
    "/",
    customerOnly,
    createRateLimiter({
      windowMs: 60_000,
      limit: env.isTest ? 1000 : 20,
      message: "Too many reviews at once. Please wait a moment.",
    }),
    validate(rules.createRules),
    respond(
      asReview((req) => reviews.create(req.user, req.body)),
      "Thanks for your review",
      201,
    ),
  )
  .get(
    "/mine",
    customerOnly,
    validate(rules.mineRules),
    respond((req) =>
      reviews.listMine(req.user._id, req.validatedQuery, page(req)),
    ),
  )
  .get(
    "/:id",
    customerOnly,
    validate([mongoIdParam()]),
    respond(asReview((req) => reviews.getMine(req.user._id, req.params.id))),
  )
  .patch(
    "/:id",
    customerOnly,
    validate(rules.updateRules),
    respond(
      asReview((req) => reviews.update(req.user._id, req.params.id, req.body)),
      "Review updated",
    ),
  )
  .delete(
    "/:id",
    customerOnly,
    validate([mongoIdParam()]),
    respond(
      (req) => reviews.remove(req.user._id, req.params.id),
      "Review deleted",
    ),
  )
  .post(
    "/:id/reports",
    authorize(ROLES.CUSTOMER, ROLES.RESTAURANT, ROLES.DELIVERY),
    createRateLimiter({
      windowMs: 15 * 60_000,
      limit: env.isTest ? 1000 : 20,
      message: "Too many reports. Try again later.",
    }),
    validate(rules.reportRules),
    respond(
      (req) => reviews.report(req.user, req.params.id, req.body),
      "Thanks. Our team will take a look.",
      201,
    ),
  );

/** /api/v1/admin/reviews: the moderation queue, decisions and rating analytics. */
export const adminReviewsRouter = Router()
  .use(authenticate, can(PERMISSIONS.REVIEWS_MODERATE))
  .get(
    "/orders",
    validate(rules.adminListRules),
    respond((req) =>
      moderation.adminOrders(
        req.validatedQuery,
        parsePagination(req.validatedQuery),
      ),
    ),
  )
  .get(
    "/orders/:orderId",
    validate([mongoIdParam("orderId")]),
    respond((req) => moderation.adminOrder(req.params.orderId)),
  )
  .get(
    "/analytics",
    validate(daysRules),
    respond((req) => moderation.analytics(req.validatedQuery.days ?? 30)),
  )
  .get(
    "/:id",
    validate([mongoIdParam()]),
    respond(asReview((req) => moderation.adminGet(req.params.id))),
  )
  .post(
    "/:id/moderation",
    validate(rules.moderateRules),
    audited("review.moderate", "review", (req) =>
      `Review ${moderation.PAST[req.body.action]}: ${req.body.reason}`,
    ),
    respond(
      asReview((req) =>
        moderation.moderate(req.user._id, req.params.id, req.body),
      ),
      (req) => `Review ${moderation.PAST[req.body.action]}`,
    ),
  )
  .post(
    "/:id/reports/dismiss",
    validate(rules.dismissRules),
    respond(
      asReview((req) =>
        moderation.dismissReports(req.user._id, req.params.id, req.body.reason),
      ),
      "Reports dismissed",
    ),
  );
