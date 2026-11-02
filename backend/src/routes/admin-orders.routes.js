import { Router } from "express";
import * as c from "../controllers/order-management.controller.js";
import { authenticate, authorize } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { ROLES } from "../models/user.model.js";
import { mongoIdParam } from "../validators/common.validators.js";
import * as rules from "../validators/order-management.validators.js";

const adminOnly = [authenticate, authorize(ROLES.ADMIN)];

/** /api/v1/admin/orders: monitor every order, cancel or unassign stuck ones. */
export const adminOrdersRouter = Router()
  .use(...adminOnly)
  .get("/", validate(rules.adminOrderListRules), c.adminList)
  .get("/:id", validate([mongoIdParam()]), c.adminGet)
  .post("/:id/cancel", validate(rules.adminCancelRules), c.adminCancel)
  .post("/:id/unassign", validate(rules.adminUnassignRules), c.adminUnassign);

/** /api/v1/admin/delivery-partners: riders, their availability, suspend/reactivate. */
export const adminDeliveryPartnersRouter = Router()
  .use(...adminOnly)
  .get("/", validate(rules.adminRiderListRules), c.adminRiderList)
  .patch("/:id/status", validate(rules.adminRiderStatusRules), c.adminRiderSetStatus);
