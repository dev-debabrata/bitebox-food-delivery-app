import { body, header, param, query } from "express-validator";
import { MAX_ITEM_QUANTITY } from "../models/cart.model.js";
import { DISCOUNT_TYPES } from "../models/coupon.model.js";
import { PAYMENT_METHODS } from "../models/order.model.js";
import {
  booleanQuery,
  mongoIdParam,
  paginationRules,
  searchQuery,
} from "./common.validators.js";

// Cart
export const addItemRules = [
  body("foodItemId").isMongoId().withMessage("Invalid dish"),
  body("quantity")
    .optional()
    .isInt({ min: 1, max: MAX_ITEM_QUANTITY })
    .withMessage(`Quantity must be 1-${MAX_ITEM_QUANTITY}`)
    .toInt(),
  body("replace").optional().isBoolean().toBoolean(),
];

export const setQuantityRules = [
  param("foodItemId").isMongoId().withMessage("Invalid dish"),
  body("quantity")
    .isInt({ min: 0, max: MAX_ITEM_QUANTITY })
    .withMessage(`Quantity must be 0-${MAX_ITEM_QUANTITY}`)
    .toInt(),
];

export const removeItemRules = [
  param("foodItemId").isMongoId().withMessage("Invalid dish"),
];

export const couponCodeRules = [
  body("code")
    .isString()
    .trim()
    .toUpperCase()
    .matches(/^[A-Z0-9_-]{3,30}$/)
    .withMessage("Enter a valid coupon code"),
];

export const quoteRules = [
  query("addressId").optional().isMongoId().withMessage("Invalid address"),
];

// Addresses
function addressRules({ partial }) {
  const field = (name) => (partial ? body(name).optional() : body(name));
  return [
    body("label").optional().isIn(["home", "work", "other"]),
    field("recipientName")
      .isString()
      .trim()
      .isLength({ min: 2, max: 80 })
      .withMessage("Name must be 2-80 characters"),
    field("phone")
      .isString()
      .trim()
      .matches(/^\+?[0-9]{10,15}$/)
      .withMessage("Enter a valid phone number"),
    field("line1")
      .isString()
      .trim()
      .isLength({ min: 3, max: 120 })
      .withMessage("House / flat and street are required"),
    body("line2").optional().isString().trim().isLength({ max: 120 }),
    body("area").optional().isString().trim().isLength({ max: 80 }),
    body("landmark").optional().isString().trim().isLength({ max: 80 }),
    field("city")
      .isString()
      .trim()
      .isLength({ min: 2, max: 60 })
      .withMessage("City is required"),
    field("state")
      .isString()
      .trim()
      .isLength({ min: 2, max: 60 })
      .withMessage("State is required"),
    field("postalCode")
      .isString()
      .trim()
      .matches(/^[A-Za-z0-9 -]{3,10}$/)
      .withMessage("Enter a valid PIN code"),
    field("location").isObject().withMessage("Pin the location"),
    body("location.latitude")
      .if(body("location").exists())
      .isFloat({ min: -90, max: 90 })
      .withMessage("Latitude must be -90 to 90")
      .toFloat(),
    body("location.longitude")
      .if(body("location").exists())
      .isFloat({ min: -180, max: 180 })
      .withMessage("Longitude must be -180 to 180")
      .toFloat(),
    body("isDefault").optional().isBoolean().toBoolean(),
  ];
}

export const createAddressRules = addressRules({ partial: false });
export const updateAddressRules = [
  mongoIdParam(),
  ...addressRules({ partial: true }),
];

// Orders
export const placeOrderRules = [
  header("idempotency-key")
    .optional()
    .isString()
    .matches(/^[A-Za-z0-9_-]{8,100}$/)
    .withMessage("Idempotency-Key must be 8-100 letters, digits, - or _"),
  body("addressId").isMongoId().withMessage("Choose a delivery address"),
  body("paymentMethod")
    .isIn(Object.values(PAYMENT_METHODS))
    .withMessage("Choose a payment method"),
  body("note").optional().isString().trim().isLength({ max: 300 }),
  body("expectedTotalPaise").optional().isInt({ min: 0 }).toInt(),
];

export const listOrdersRules = paginationRules;

// Coupons (admin)
const nullableInt = (field, min) =>
  body(field)
    .optional()
    .custom(
      (v) =>
        v === null ||
        (Number.isInteger(Number(v)) && Number(v) >= min && v !== ""),
    )
    .withMessage(`${field} must be a whole number of at least ${min}, or null`)
    .customSanitizer((v) => (v === null ? null : Number(v)));

function couponRules({ partial }) {
  const field = (name) => (partial ? body(name).optional() : body(name));
  return [
    field("code")
      .isString()
      .trim()
      .toUpperCase()
      .matches(/^[A-Z0-9_-]{3,30}$/)
      .withMessage("Code: 3-30 letters, digits, - or _"),
    body("description").optional().isString().trim().isLength({ max: 200 }),
    field("discountType")
      .isIn(Object.values(DISCOUNT_TYPES))
      .withMessage("Choose percent or flat"),
    field("discountValue")
      .isInt({ min: 1 })
      .withMessage("Discount must be a positive whole number")
      .toInt(),
    nullableInt("maxDiscountPaise", 0),
    body("minOrderPaise").optional().isInt({ min: 0 }).toInt(),
    field("validFrom").isISO8601().withMessage("Invalid start date").toDate(),
    field("validUntil").isISO8601().withMessage("Invalid end date").toDate(),
    body("isActive").optional().isBoolean().toBoolean(),
    nullableInt("usageLimit", 1),
    body("perUserLimit").optional().isInt({ min: 1, max: 100 }).toInt(),
    body("restaurant")
      .optional()
      .custom((v) => v === null || /^[a-f0-9]{24}$/i.test(String(v)))
      .withMessage("Invalid restaurant"),
  ];
}

export const createCouponRules = couponRules({ partial: false });
export const updateCouponRules = [
  mongoIdParam(),
  ...couponRules({ partial: true }),
];
export const adminCouponListRules = [
  ...paginationRules,
  searchQuery(),
  booleanQuery("active"),
];
export const availableCouponRules = [
  query("restaurantId").optional().isMongoId(),
];
