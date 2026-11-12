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
import * as rules from "../validators/order-management.validators.js";
import { daysRules } from "../validators/payment.validators.js";

export default Router()
  .use(authenticate, authorize(ROLES.DELIVERY))
  .get("/me", c.riderDashboard)
  .put("/me/vehicle", validate(rules.vehicleRules), c.riderUpdateVehicle)
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
  .get(
    "/earnings",
    validate(daysRules),
    respond((req) =>
      reports.riderEarnings(req.user._id, req.validatedQuery.days ?? 30),
    ),
  );
