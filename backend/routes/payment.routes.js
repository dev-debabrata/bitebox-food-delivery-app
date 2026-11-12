import express, { Router } from "express";
import { authenticate, authorize } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { ROLES } from "../models/user.model.js";
import { abandonUnpaid } from "../services/order-management.service.js";
import * as payments from "../services/payments/payment.service.js";
import { respond } from "../utils/api-response.js";
import * as rules from "../validators/payment.validators.js";

const customer = [authenticate, authorize(ROLES.CUSTOMER)];
const asPayment = (payment) => ({ payment });

/** /api/v1/payments: checkout payment steps for the customer's own orders. */
export const paymentsRouter = Router()
  .get(
    "/methods",
    respond(async () => ({ methods: payments.availableMethods() })),
  )
  .post(
    "/orders/:orderId/start",
    ...customer,
    validate(rules.orderIdRules),
    respond(async (req) => ({
      checkout: await payments.startPayment(req.user._id, req.params.orderId),
    })),
  )
  .post(
    "/orders/:orderId/confirm",
    ...customer,
    validate(rules.confirmRules),
    respond(async (req) =>
      asPayment(
        await payments.confirmPayment(
          req.user._id,
          req.params.orderId,
          req.body,
        ),
      ),
    ),
  )
  // Closed the payment page at checkout: cancel the unpaid order and refill the cart.
  .post(
    "/orders/:orderId/abandon",
    ...customer,
    validate(rules.orderIdRules),
    respond((req) => abandonUnpaid(req.user._id, req.params.orderId)),
  )
  // Development only (refused when the simulated provider is disabled).
  .post(
    "/orders/:orderId/mock",
    ...customer,
    validate(rules.mockRules),
    respond(async (req) =>
      asPayment(
        await payments.completeMockPayment(
          req.user._id,
          req.params.orderId,
          req.body.outcome,
        ),
      ),
    ),
  );

export const razorpayWebhookRouter = Router().post(
  "/",
  express.raw({ type: "application/json", limit: "100kb" }),
  respond((req) =>
    payments.handleRazorpayWebhook(
      req.body.toString("utf8"),
      req.get("x-razorpay-signature"),
      req.get("x-razorpay-event-id"),
    ),
  ),
);
