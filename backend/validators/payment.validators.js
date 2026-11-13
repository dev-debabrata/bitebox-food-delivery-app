import { body, query } from "express-validator";
import { PAYMENT_METHODS, PAYMENT_STATUS } from "../models/order.model.js";
import { mongoIdParam, paginationRules } from "./common.validators.js";

export const orderIdRules = [mongoIdParam("orderId")];
export const confirmRules = [
  mongoIdParam("orderId"),
  body("providerPaymentId")
    .isString()
    .trim()
    .isLength({ min: 4, max: 100 })
    .withMessage("Missing payment id"),
  body("signature")
    .isString()
    .trim()
    .isLength({ min: 16, max: 200 })
    .withMessage("Missing signature"),
];
export const mockRules = [
  mongoIdParam("orderId"),
  body("outcome")
    .isIn(["success", "failure"])
    .withMessage("Outcome must be success or failure"),
];
export const daysRules = [
  query("days").optional().isInt({ min: 1, max: 365 }).toInt(),
];
export const adminPaymentListRules = [
  query("status").optional().isIn(Object.values(PAYMENT_STATUS)),
  query("method").optional().isIn(Object.values(PAYMENT_METHODS)),
  query("provider").optional().isIn(["cash_on_delivery", "razorpay", "mock"]),
  query("orderState").optional().isIn(["active", "delivered", "cancelled"]),
  // Order number, or the customer's name, email or phone.
  query("search").optional().isString().trim().isLength({ max: 100 }),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
  ...paginationRules,
];
export const paymentIdRules = [mongoIdParam()];
export const refundRules = [
  mongoIdParam(),
  body("amountPaise")
    .isInt({ min: 1 })
    .withMessage("Enter an amount to refund")
    .toInt(),
  body("reason")
    .exists({ values: "falsy" })
    .withMessage("Give a reason")
    .bail()
    .isString()
    .trim()
    .isLength({ min: 1, max: 300 })
    .withMessage("Keep the reason under 300 characters"),
];
