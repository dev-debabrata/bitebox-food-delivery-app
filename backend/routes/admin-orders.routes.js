import { Router } from "express";
import * as c from "../controllers/order-management.controller.js";
import { PERMISSIONS } from "../config/permissions.js";
import { authenticate, can } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { audited } from "../services/audit.service.js";
import { mongoIdParam } from "../validators/common.validators.js";
import * as rules from "../validators/order-management.validators.js";
import * as paymentRules from "../validators/payment.validators.js";
import * as payments from "../services/payments/payment.service.js";
import * as reports from "../services/reports.service.js";
import { respond } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";

const P = PERMISSIONS;

/** /api/v1/admin/orders: monitor every order, cancel or unassign stuck ones. */
export const adminOrdersRouter = Router()
  .use(authenticate)
  .get("/", can(P.ORDERS_VIEW), validate(rules.adminOrderListRules), c.adminList)
  .get("/:id", can(P.ORDERS_VIEW), validate([mongoIdParam()]), c.adminGet)
  .post(
    "/:id/cancel",
    can(P.ORDERS_MANAGE),
    validate(rules.adminCancelRules),
    audited("order.cancel", "order", (req) => `Cancelled order: ${req.body.reason}`),
    c.adminCancel,
  )
  .post(
    "/:id/unassign",
    can(P.ORDERS_MANAGE),
    validate(rules.adminUnassignRules),
    audited("order.unassign", "order", (req) =>
      ["Unassigned the rider", req.body.reason].filter(Boolean).join(": "),
    ),
    c.adminUnassign,
  );

/** /api/v1/admin/payments: every payment; retry a failed refund. */
export const adminPaymentsRouter = Router()
  .use(authenticate)
  .get(
    "/",
    can(P.FINANCE_VIEW),
    validate(paymentRules.adminPaymentListRules),
    respond((req) =>
      payments.adminList(
        req.validatedQuery,
        parsePagination(req.validatedQuery),
      ),
    ),
  )
  .post(
    "/:id/refund",
    can(P.REFUNDS_MANAGE),
    validate(paymentRules.paymentIdRules),
    audited("payment.refund", "payment", () => "Retried a failed refund"),
    respond(
      async (req) => ({
        payment: await payments.adminRetryRefund(req.params.id),
      }),
      "Refund issued",
    ),
  );

/** /api/v1/admin/reports?days=30: platform analytics. */
export const adminReportsRouter = Router()
  .use(authenticate, can(P.FINANCE_VIEW))
  .get(
    "/",
    validate(paymentRules.daysRules),
    respond((req) => reports.adminReport(req.validatedQuery.days ?? 30)),
  );

/** /api/v1/admin/delivery-partners: riders, their availability, suspend/reactivate. */
export const adminDeliveryPartnersRouter = Router()
  .use(authenticate, can(P.RIDERS_MANAGE))
  .get("/", validate(rules.adminRiderListRules), c.adminRiderList)
  .patch(
    "/:id/status",
    validate(rules.adminRiderStatusRules),
    audited("rider.status", "user", (req) => `Set rider status to ${req.body.status}`),
    c.adminRiderSetStatus,
  );
