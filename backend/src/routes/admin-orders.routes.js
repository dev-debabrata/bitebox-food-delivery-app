import { Router } from "express";
import * as c from "../controllers/order-management.controller.js";
import { authenticate, authorize } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { ROLES } from "../models/user.model.js";
import { mongoIdParam } from "../validators/common.validators.js";
import * as rules from "../validators/order-management.validators.js";
import * as paymentRules from "../validators/payment.validators.js";
import * as payments from "../services/payments/payment.service.js";
import * as reports from "../services/reports.service.js";
import { respond } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";

const adminOnly = [authenticate, authorize(ROLES.ADMIN)];

/** /api/v1/admin/orders: monitor every order, cancel or unassign stuck ones. */
export const adminOrdersRouter = Router()
  .use(...adminOnly)
  .get("/", validate(rules.adminOrderListRules), c.adminList)
  .get("/:id", validate([mongoIdParam()]), c.adminGet)
  .post("/:id/cancel", validate(rules.adminCancelRules), c.adminCancel)
  .post("/:id/unassign", validate(rules.adminUnassignRules), c.adminUnassign);

/** /api/v1/admin/payments: every payment; retry a failed refund. */
export const adminPaymentsRouter = Router()
  .use(...adminOnly)
  .get("/", validate(paymentRules.adminPaymentListRules), respond((req) => payments.adminList(req.validatedQuery, parsePagination(req.validatedQuery))))
  .post("/:id/refund", validate(paymentRules.paymentIdRules), respond(async (req) => ({ payment: await payments.adminRetryRefund(req.params.id) }), "Refund issued"));

/** /api/v1/admin/reports?days=30: platform analytics. */
export const adminReportsRouter = Router()
  .use(...adminOnly)
  .get("/", validate(paymentRules.daysRules), respond((req) => reports.adminReport(req.validatedQuery.days ?? 30)));

/** /api/v1/admin/delivery-partners: riders, their availability, suspend/reactivate. */
export const adminDeliveryPartnersRouter = Router()
  .use(...adminOnly)
  .get("/", validate(rules.adminRiderListRules), c.adminRiderList)
  .patch("/:id/status", validate(rules.adminRiderStatusRules), c.adminRiderSetStatus);
