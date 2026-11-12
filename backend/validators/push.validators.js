import { body } from "express-validator";
import { PUSH_CATEGORIES } from "../services/push.service.js";

const base64url = (field, min, max) =>
  body(field)
    .isString()
    .withMessage("Invalid subscription key")
    .bail()
    .matches(new RegExp(`^[A-Za-z0-9_-]{${min},${max}}={0,2}$`))
    .withMessage("Invalid subscription key");

const endpoint = () =>
  body("endpoint")
    .isString()
    .withMessage("Endpoint is required")
    .bail()
    .trim()
    .isLength({ min: 20, max: 1000 })
    .withMessage("Invalid endpoint")
    .bail()
    .isURL({ protocols: ["https"], require_protocol: true, require_tld: true })
    .withMessage("Endpoint must be an https URL");

/** The browser's PushSubscription.toJSON(): { endpoint, expirationTime, keys: { p256dh, auth } }. */
export const subscribeRules = [
  endpoint(),
  // p256dh is a 65-byte P-256 public key (87 chars), auth is 16 bytes (22 chars), base64url.
  base64url("keys.p256dh", 80, 100),
  base64url("keys.auth", 16, 32),
  body("expirationTime")
    .optional({ values: "null" })
    .isInt({ min: 0 })
    .withMessage("Invalid expiration time")
    .toInt(),
];

export const unsubscribeRules = [endpoint()];

export const preferencesRules = PUSH_CATEGORIES.map((category) =>
  body(category)
    .optional()
    .isBoolean({ strict: true })
    .withMessage(`${category} must be true or false`),
);

const sitePath = /^\/(?!\/)[A-Za-z0-9\-._~/?#[\]@!$&'()*+,;=%]{0,199}$/;

export const promotionRules = [
  body("title").isString().trim().isLength({ min: 3, max: 60 }).withMessage("Title must be 3–60 characters"),
  body("body").isString().trim().isLength({ min: 3, max: 160 }).withMessage("Message must be 3–160 characters"),
  body("link")
    .optional({ values: "falsy" })
    .isString()
    .trim()
    .matches(sitePath)
    .withMessage("Link must be a BiteBox page such as /restaurants"),
];
