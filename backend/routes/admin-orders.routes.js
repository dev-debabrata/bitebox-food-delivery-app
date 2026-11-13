import { Router } from "express";
import * as c from "../controllers/order-management.controller.js";
import { orderInvoiceFor } from "../controllers/partner-finance.controller.js";
import { PERMISSIONS } from "../config/permissions.js";
import { authenticate, can } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { audited } from "../services/audit.service.js";
import { mongoIdParam } from "../validators/common.validators.js";
import * as rules from "../validators/order-management.validators.js";
import * as paymentRules from "../validators/payment.validators.js";
import * as payments from "../services/payments/payment.service.js";
import * as reports from "../services/reports.service.js";
import { rupees } from "../services/order-notifications.js";
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
  )
  .post(
    "/:id/assign",
    can(P.ORDERS_MANAGE),
    validate(rules.adminAssignRules),
    audited("order.assign", "order", () => "Assigned a rider manually"),
    c.adminAssign,
  )
  .post(
    "/:id/delivery-code",
    can(P.ORDERS_MANAGE),
    validate([mongoIdParam()]),
    audited("order.delivery_code", "order", () => "Issued a new delivery code"),
    c.adminResetDeliveryOtp,
  )
  .get("/:id/timeline", can(P.ORDERS_VIEW), validate([mongoIdParam()]), c.adminTimeline)
  .get("/:id/invoice", can(P.FINANCE_VIEW), validate([mongoIdParam()]), orderInvoiceFor(false));

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
  )
  .get(
    "/:id",
    can(P.FINANCE_VIEW),
    validate(paymentRules.paymentIdRules),
    respond((req) => payments.adminGet(req.params.id)),
  )
  // A full or partial refund. An Idempotency-Key header makes a retried request safe.
  .post(
    "/:id/refunds",
    can(P.REFUNDS_MANAGE),
    validate(paymentRules.refundRules),
    audited(
      "payment.partial_refund",
      "payment",
      (req) => `Refunded ${rupees(req.body.amountPaise)}: ${req.body.reason}`,
    ),
    respond(
      (req) =>
        payments.adminRefund(
          req.user._id,
          req.params.id,
          req.body,
          /^[A-Za-z0-9_-]{8,100}$/.test(req.get("idempotency-key") ?? "")
            ? req.get("idempotency-key")
            : undefined,
        ),
      "Refund started",
    ),
  );

/** /api/v1/admin/refunds/:id/paid: finance paid a cash refund back by hand. */
export const adminRefundsRouter = Router()
  .use(authenticate, can(P.REFUNDS_MANAGE))
  .post(
    "/:id/paid",
    validate([mongoIdParam()]),
    audited("payment.refund_paid", "refund", () => "Marked a cash refund as paid"),
    respond((req) => payments.adminCompleteManualRefund(req.params.id), "Refund marked as paid"),
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
  .get("/:id", validate([mongoIdParam()]), c.adminRiderGet)
  .patch(
    "/:id/verification",
    validate(rules.adminRiderVerificationRules),
    audited("rider.verification", "user", (req) => `Set rider verification to ${req.body.status}`),
    c.adminRiderSetVerification,
  )
  .patch(
    "/:id/status",
    validate(rules.adminRiderStatusRules),
    audited("rider.status", "user", (req) => `Set rider status to ${req.body.status}`),
    c.adminRiderSetStatus,
  );
