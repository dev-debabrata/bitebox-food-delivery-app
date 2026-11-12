import { Router } from "express";
import { PERMISSIONS } from "../config/permissions.js";
import { authenticate, can } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import * as ops from "../services/operations.service.js";
import { respond } from "../utils/api-response.js";
import { daysRules } from "../validators/payment.validators.js";

/**
 * /api/v1/admin/operations: the operations dashboard, live order board, restaurant availability and
 * delivery performance. Order actions (cancel, unassign), restaurant approval and rider management
 * use the existing /admin/orders, /admin/restaurants and /admin/delivery-partners endpoints.
 */
export const adminOperationsRouter = Router()
  .use(authenticate, can(PERMISSIONS.OPERATIONS_VIEW))
  .get(
    "/dashboard",
    validate(daysRules),
    respond((req) => ops.dashboard(req.validatedQuery.days ?? 30)),
  )
  .get(
    "/monitoring",
    respond(() => ops.monitoring()),
  )
  .get(
    "/restaurants",
    respond(() => ops.restaurantAvailability()),
  )
  .get(
    "/performance",
    validate(daysRules),
    respond((req) => ops.deliveryPerformance(req.validatedQuery.days ?? 30)),
  );
