import { body, param, query } from "express-validator";
import { PAYOUT_STATUS, PAYOUT_TYPES } from "../models/payout.model.js";
import { mongoIdParam, paginationRules } from "./common.validators.js";

const payoutType = (location) =>
  location("type")
    .isIn(Object.values(PAYOUT_TYPES))
    .withMessage("Type must be restaurant or rider");

export const dueRules = [payoutType(query)];
export const listPayoutRules = [
  ...paginationRules,
  query("type").optional().isIn(Object.values(PAYOUT_TYPES)),
  query("status").optional().isIn(Object.values(PAYOUT_STATUS)),
];
export const createPayoutRules = [
  payoutType(body),
  body("payeeId").isMongoId().withMessage("Choose who to pay"),
  body("note").optional().isString().trim().isLength({ max: 500 }),
];
export const payPayoutRules = [
  mongoIdParam(),
  body("reference")
    .isString()
    .trim()
    .isLength({ min: 3, max: 120 })
    .withMessage("Enter the bank or UPI transfer reference"),
];
export const cancelPayoutRules = [
  mongoIdParam(),
  body("note").optional().isString().trim().isLength({ max: 500 }),
];
export const refundListRules = [
  ...paginationRules,
  query("state").optional().isIn(["needed", "refunded"]),
];
export const transactionRules = [param("id").isMongoId()];
export const idParam = () => mongoIdParam();
export const pageRules = paginationRules;
export const commissionRuleRules = [
  body("restaurantId").optional({ values: "null" }).isMongoId().withMessage("Invalid restaurant"),
  body("basisPoints")
    .isInt({ min: 0, max: 5000 })
    .withMessage("Commission must be between 0 and 50 percent")
    .toInt(),
  body("note").optional().isString().trim().isLength({ max: 300 }),
];
export const csvRules = [
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
];
