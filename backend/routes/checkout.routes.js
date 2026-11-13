import { Router } from "express";
import * as c from "../controllers/checkout.controller.js";
import * as orders from "../controllers/order-management.controller.js";
import { orderInvoiceFor } from "../controllers/partner-finance.controller.js";
import { env } from "../config/env.js";
import { PERMISSIONS } from "../config/permissions.js";
import { authenticate, authorize, can } from "../middleware/auth.middleware.js";
import { createRateLimiter } from "../middleware/security.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { ROLES } from "../models/user.model.js";
import * as rules from "../validators/checkout.validators.js";
import * as orderRules from "../validators/order-management.validators.js";
import { cartCoinsRules } from "../validators/rewards.validators.js";
import { mongoIdParam } from "../validators/common.validators.js";
import { orderReviews, reviewOrder } from "../services/review.service.js";
import { orderReviewRules } from "../validators/review.validators.js";
import { respond } from "../utils/api-response.js";

const customerOnly = [authenticate, authorize(ROLES.CUSTOMER)];

/** /api/v1/cart */
export const cartRouter = Router()
  .use(...customerOnly)
  .get("/", validate(rules.quoteRules), c.getCart)
  .delete("/", validate(rules.quoteRules), c.clearCart)
  .post(
    "/items",
    validate([...rules.quoteRules, ...rules.addItemRules]),
    c.addItem,
  )
  .patch(
    "/items/:foodItemId",
    validate([...rules.quoteRules, ...rules.setQuantityRules]),
    c.setQuantity,
  )
  .delete(
    "/items/:foodItemId",
    validate([...rules.quoteRules, ...rules.removeItemRules]),
    c.removeItem,
  )
  .post(
    "/coupon",
    // Slow down coupon-code guessing.
    createRateLimiter({
      windowMs: 15 * 60_000,
      limit: env.isTest ? 1000 : 30,
      message: "Too many coupon attempts. Try again later.",
    }),
    validate([...rules.quoteRules, ...rules.couponCodeRules]),
    c.applyCoupon,
  )
  .delete("/coupon", validate(rules.quoteRules), c.removeCoupon)
  .put("/coins", validate([...rules.quoteRules, ...cartCoinsRules]), c.setCoins)
  .delete("/coins", validate(rules.quoteRules), c.removeCoins);

/** /api/v1/addresses */
export const addressesRouter = Router()
  .use(...customerOnly)
  .get("/", c.listAddresses)
  .post("/", validate(rules.createAddressRules), c.createAddress)
  .patch("/:id", validate(rules.updateAddressRules), c.updateAddress)
  .patch("/:id/default", validate([mongoIdParam()]), c.setDefaultAddress)
  .delete("/:id", validate([mongoIdParam()]), c.deleteAddress);

/** /api/v1/orders (customer view; restaurants, riders and admins have their own routers) */
export const ordersRouter = Router()
  .use(...customerOnly)
  .post(
    "/",
    createRateLimiter({
      windowMs: 60_000,
      limit: env.isTest ? 1000 : 10,
      message: "Too many order attempts. Please wait a moment.",
    }),
    validate(rules.placeOrderRules),
    c.placeOrder,
  )
  .get("/", validate(rules.listOrdersRules), c.listMyOrders)
  .get("/:id", validate([mongoIdParam()]), orders.customerGet)
  .get("/:id/timeline", validate([mongoIdParam()]), orders.customerTimeline)
  .get("/:id/invoice", validate([mongoIdParam()]), orderInvoiceFor(true))
  .get(
    "/:id/reviews",
    validate([mongoIdParam()]),
    respond((req) => orderReviews(req.user._id, req.params.id)),
  )
  .post(
    "/:id/reviews",
    validate(orderReviewRules),
    respond(
      (req) => reviewOrder(req.user, req.params.id, req.body),
      "Thanks for rating your order",
      201,
    ),
  )
  .post(
    "/:id/cancel",
    validate(orderRules.customerCancelRules),
    orders.customerCancel,
  );

/** /api/v1/coupons (signed-in customers) */
export const couponsRouter = Router()
  .use(...customerOnly)
  .get("/available", validate(rules.availableCouponRules), c.availableCoupons);

/** /api/v1/admin/coupons */
export const adminCouponsRouter = Router()
  .use(authenticate, can(PERMISSIONS.CATALOG_MANAGE))
  .get("/", validate(rules.adminCouponListRules), c.adminListCoupons)
  .post("/", validate(rules.createCouponRules), c.adminCreateCoupon)
  .patch("/:id", validate(rules.updateCouponRules), c.adminUpdateCoupon)
  .delete("/:id", validate([mongoIdParam()]), c.adminDeleteCoupon);
