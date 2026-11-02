import { body, query } from "express-validator";
import { VEHICLE_TYPES } from "../models/delivery-partner.model.js";
import { ORDER_STATUS } from "../models/order.model.js";
import { USER_STATUS } from "../models/user.model.js";
import { booleanQuery, mongoIdParam, paginationRules, searchQuery } from "./common.validators.js";

const S = ORDER_STATUS;
const reason = (required = false) => {
  const chain = body("reason");
  return (required ? chain.exists({ values: "falsy" }).withMessage("Give a reason") : chain.optional())
    .isString()
    .trim()
    .isLength({ max: 300 })
    .withMessage("Keep the reason under 300 characters");
};
const latitude = () => body("latitude").isFloat({ min: -90, max: 90 }).withMessage("Invalid latitude").toFloat();
const longitude = () => body("longitude").isFloat({ min: -180, max: 180 }).withMessage("Invalid longitude").toFloat();

// Customer ------------------------------------------------------------------
export const customerCancelRules = [mongoIdParam(), reason()];

// Restaurant ----------------------------------------------------------------
export const restaurantListRules = [
  query("view").optional().isIn(["active", "history"]),
  query("status").optional().isIn(Object.values(S)),
  ...paginationRules,
];
export const restaurantStatusRules = [
  mongoIdParam(),
  body("status")
    .isIn([S.CONFIRMED, S.REJECTED, S.PREPARING, S.READY_FOR_PICKUP])
    .withMessage("Status must be confirmed, rejected, preparing or ready_for_pickup"),
  reason(),
];

// Rider ---------------------------------------------------------------------
export const vehicleRules = [
  body("vehicleType").isIn(VEHICLE_TYPES).withMessage(`Vehicle must be one of: ${VEHICLE_TYPES.join(", ")}`),
  body("vehicleNumber")
    .optional({ values: "falsy" })
    .isString()
    .trim()
    .matches(/^[A-Za-z0-9 -]{4,20}$/)
    .withMessage("Enter a valid vehicle number"),
];
export const availabilityRules = [
  body("isOnline").isBoolean().withMessage("isOnline must be true or false").toBoolean(),
  latitude().optional(),
  longitude().optional(),
];
export const locationRules = [latitude(), longitude()];
export const offerRules = [mongoIdParam()];
export const riderStatusRules = [
  mongoIdParam(),
  body("status").isIn([S.PICKED_UP, S.ON_THE_WAY, S.DELIVERED]).withMessage("Status must be picked_up, on_the_way or delivered"),
];
export const riderHistoryRules = paginationRules;

// Admin ---------------------------------------------------------------------
export const adminOrderListRules = [
  query("status").optional().isIn([...Object.values(S), "active"]),
  searchQuery(),
  ...paginationRules,
];
export const adminCancelRules = [mongoIdParam(), reason(true)];
export const adminUnassignRules = [mongoIdParam(), reason()];
export const adminRiderListRules = [searchQuery(), booleanQuery("online"), ...paginationRules];
export const adminRiderStatusRules = [
  mongoIdParam(),
  body("status").isIn(Object.values(USER_STATUS)).withMessage("Status must be active or suspended"),
];
