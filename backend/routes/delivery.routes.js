import { Router } from "express";
import * as c from "../controllers/order-management.controller.js";
import { env } from "../config/env.js";
import { authenticate, authorize } from "../middleware/auth.middleware.js";
import { createRateLimiter } from "../middleware/security.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { ROLES } from "../models/user.model.js";
import * as reports from "../services/reports.service.js";
import * as reviews from "../services/review.service.js";
import { parsePagination } from "../utils/pagination.js";
import { riderListRules } from "../validators/review.validators.js";
import { respond } from "../utils/api-response.js";
import * as partnerFinance from "../controllers/partner-finance.controller.js";
import { mongoIdParam, paginationRules } from "../validators/common.validators.js";
import * as rules from "../validators/order-management.validators.js";
import { daysRules } from "../validators/payment.validators.js";

export default Router()
  .use(authenticate, authorize(ROLES.DELIVERY))
  .get("/me", c.riderDashboard)
  .put("/me/vehicle", validate(rules.vehicleRules), c.riderUpdateVehicle)
  .patch("/me/details", validate(rules.riderDetailsRules), c.riderUpdateDetails)
  .post("/me/resubmit", c.riderResubmit)
  .patch(
    "/me/availability",
    validate(rules.availabilityRules),
    c.riderSetAvailability,
  )
  .put(
    "/me/location",
    createRateLimiter({
      windowMs: 60_000,
      limit: env.isTest ? 1000 : 30,
      message: "Location updates are too frequent",
    }),
    validate(rules.locationRules),
    c.riderUpdateLocation,
  )
  .post("/offers/:id/accept", validate(rules.offerRules), c.riderAcceptOffer)
  .post("/offers/:id/decline", validate(rules.offerRules), c.riderDeclineOffer)
  .patch(
    "/orders/:id/status",
    validate(rules.riderStatusRules),
    c.riderSetStatus,
  )
  .get("/orders/history", validate(rules.riderHistoryRules), c.riderHistory)
  .get(
    "/reviews",
    validate(riderListRules),
    respond((req) =>
      reviews.riderList(
        req.user._id,
        req.validatedQuery,
        parsePagination(req.validatedQuery, { defaultLimit: 10 }),
      ),
    ),
  )
  .get("/payouts", validate(paginationRules), partnerFinance.myPayouts)
  .get("/payouts/:id/statement", validate([mongoIdParam()]), partnerFinance.myStatement)
  .get("/settlements", validate(paginationRules), partnerFinance.mySettlements)
  // Today, this week and all-time deliveries and earnings, plus the rating.
  .get("/stats", respond((req) => reports.riderStats(req.user._id)))
  .get(
    "/earnings",
    validate(daysRules),
    respond((req) =>
      reports.riderEarnings(req.user._id, req.validatedQuery.days ?? 30),
    ),
  );
