import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { orderTracking } from "../services/tracking.service.js";
import { respond } from "../utils/api-response.js";
import { mongoIdParam } from "../validators/common.validators.js";

/** /api/v1/tracking: the customer of the order, its rider, or staff with orders:view. */
export const trackingRouter = Router()
  .use(authenticate)
  .get(
    "/orders/:id",
    validate([mongoIdParam()]),
    respond((req) => orderTracking(req.user, req.params.id)),
  );
