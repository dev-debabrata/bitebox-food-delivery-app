import { body, query } from "express-validator";
import { RESTAURANT_STATUS } from "../models/restaurant.model.js";
import {
  booleanQuery,
  imageUrlBody,
  mongoIdParam,
  paginationRules,
  paiseBody,
  searchQuery,
} from "./common.validators.js";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function restaurantRules({ partial }) {
  const field = (name) => (partial ? body(name).optional() : body(name));
  return [
    field("name")
      .isString()
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage("Name must be 2-100 characters"),
    body("description").optional().isString().trim().isLength({ max: 1000 }),
    field("cuisines")
      .isArray({ min: 1, max: 10 })
      .withMessage("Add between 1 and 10 cuisines"),
    body("cuisines.*")
      .isString()
      .trim()
      .isLength({ min: 2, max: 40 })
      .withMessage("Each cuisine must be 2-40 characters"),
    field("phone")
      .isString()
      .trim()
      .matches(/^\+?[0-9]{10,15}$/)
      .withMessage("Enter a valid phone number"),
    body("email")
      .optional({ values: "falsy" })
      .isEmail()
      .withMessage("Enter a valid email")
      .normalizeEmail({ gmail_remove_dots: false }),

    field("address").isObject().withMessage("Address is required"),
    body("address.line1")
      .if(body("address").exists())
      .isString()
      .trim()
      .isLength({ min: 3, max: 120 })
      .withMessage("Street address is required"),
    body("address.line2").optional().isString().trim().isLength({ max: 120 }),
    body("address.area").optional().isString().trim().isLength({ max: 80 }),
    body("address.city")
      .if(body("address").exists())
      .isString()
      .trim()
      .isLength({ min: 2, max: 60 })
      .withMessage("City is required"),
    body("address.state")
      .if(body("address").exists())
      .isString()
      .trim()
      .isLength({ min: 2, max: 60 })
      .withMessage("State is required"),
    body("address.postalCode")
      .if(body("address").exists())
      .isString()
      .trim()
      .matches(/^[A-Za-z0-9 -]{3,10}$/)
      .withMessage("Enter a valid postal code"),

    field("location").isObject().withMessage("Location is required"),
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

    imageUrlBody(),
    body("isPureVeg").optional().isBoolean().toBoolean(),
    paiseBody("costForTwoPaise", { optional: partial, min: 0 }),
    paiseBody("minOrderPaise", { optional: true, min: 0 }),
    body("avgPrepTimeMinutes")
      .optional()
      .isInt({ min: 5, max: 180 })
      .withMessage("Preparation time must be 5-180 minutes")
      .toInt(),
    field("openingTime").matches(TIME).withMessage("Use 24-hour HH:mm"),
    field("closingTime").matches(TIME).withMessage("Use 24-hour HH:mm"),
    // Legal and tax details, gallery and weekly hours (same rules as Django).
    body("ownerName").optional().isString().trim().isLength({ max: 80 }),
    body("gstRegistered").optional().isBoolean({ strict: true }),
    body("gstin")
      .optional()
      .isString()
      .trim()
      .toUpperCase()
      .custom((v) => v === "" || GSTIN.test(v))
      .withMessage("Enter a valid 15-character GSTIN"),
    body("gstin")
      .if(body("gstRegistered").equals("true"))
      .custom((v) => Boolean(v))
      .withMessage("Enter your GSTIN"),
    body("fssaiNumber")
      .optional()
      .isString()
      .trim()
      .custom((v) => v === "" || /^\d{14}$/.test(v))
      .withMessage("An FSSAI number has 14 digits"),
    body("fssaiValidUntil").optional({ values: "null" }).isISO8601().withMessage("Use a date").toDate(),
    body("photos").optional().isArray({ max: 8 }).withMessage("Add up to 8 photos"),
    imageUrlBody("photos.*"),
    body("weeklyHours")
      .optional({ values: "null" })
      .custom(validWeeklyHours)
      .withMessage("Give each day a list of opening times (HH:mm)"),
  ];
}

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
function validWeeklyHours(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((d) => !DAYS.includes(d))) return false;
  return DAYS.every((d) => {
    const slots = value[d] ?? [];
    return Array.isArray(slots) && slots.length <= 3 && slots.every((s) => TIME.test(s?.open) && TIME.test(s?.close));
  });
}

export const createRestaurantRules = restaurantRules({ partial: false });
export const updateRestaurantRules = restaurantRules({ partial: true });

export const acceptingOrdersRules = [
  body("isAcceptingOrders")
    .isBoolean()
    .withMessage("isAcceptingOrders must be true or false")
    .toBoolean(),
];

export const publicListRules = [
  ...paginationRules,
  searchQuery(),
  query("cuisine").optional().isString().trim().isLength({ max: 40 }),
  query("category").optional().isMongoId().withMessage("Invalid category"),
  booleanQuery("veg"),
  query("sort")
    .optional()
    .isIn(["rating", "fastest", "costLow", "costHigh", "newest", "distance"]),
  query("lat")
    .optional()
    .isFloat({ min: -90, max: 90 })
    .withMessage("lat must be -90 to 90")
    .bail()
    .custom((_lat, { req }) => req.query.lng !== undefined)
    .withMessage("Send both lat and lng")
    .toFloat(),
  query("lng")
    .optional()
    .isFloat({ min: -180, max: 180 })
    .withMessage("lng must be -180 to 180")
    .bail()
    .custom((_lng, { req }) => req.query.lat !== undefined)
    .withMessage("Send both lat and lng")
    .toFloat(),
  query("radiusKm").optional().isFloat({ min: 1, max: 50 }).toFloat(),
];

export const adminListRules = [
  ...paginationRules,
  searchQuery(),
  query("status").optional().isIn(Object.values(RESTAURANT_STATUS)),
];

export const adminStatusRules = [
  mongoIdParam(),
  body("status")
    .isIn(Object.values(RESTAURANT_STATUS))
    .withMessage("Invalid status"),
  body("reason").optional().isString().trim().isLength({ max: 500 }),
];
