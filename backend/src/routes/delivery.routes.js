import { Router } from "express";
import * as c from "../controllers/order-management.controller.js";
import { env } from "../config/env.js";
import { authenticate, authorize } from "../middleware/auth.middleware.js";
import { createRateLimiter } from "../middleware/security.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { ROLES } from "../models/user.model.js";
import * as rules from "../validators/order-management.validators.js";

/**
 * /api/v1/delivery: the signed-in rider's own work. Every query is scoped to
 * req.user, so a rider can only see and change their own offers and orders.
 */
export default Router()
  .use(authenticate, authorize(ROLES.DELIVERY))
  .get("/me", c.riderDashboard)
  .put("/me/vehicle", validate(rules.vehicleRules), c.riderUpdateVehicle)
  .patch("/me/availability", validate(rules.availabilityRules), c.riderSetAvailability)
  .put(
    "/me/location",
    // Devices report every few seconds at most; anything faster is a bug or abuse.
    createRateLimiter({ windowMs: 60_000, limit: env.isTest ? 1000 : 30, message: "Location updates are too frequent" }),
    validate(rules.locationRules),
    c.riderUpdateLocation,
  )
  .post("/offers/:id/accept", validate(rules.offerRules), c.riderAcceptOffer)
  .post("/offers/:id/decline", validate(rules.offerRules), c.riderDeclineOffer)
  .patch("/orders/:id/status", validate(rules.riderStatusRules), c.riderSetStatus)
  .get("/orders/history", validate(rules.riderHistoryRules), c.riderHistory);
