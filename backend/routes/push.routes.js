import { Router } from "express";
import { env } from "../config/env.js";
import { PERMISSIONS } from "../config/permissions.js";
import { authenticate, can } from "../middleware/auth.middleware.js";
import { createRateLimiter } from "../middleware/security.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { audited } from "../services/audit.service.js";
import { body } from "express-validator";
import { registerDevice, unregisterDevice } from "../services/notification.service.js";
import * as push from "../services/push.service.js";
import { respond } from "../utils/api-response.js";
import {
  preferencesRules,
  promotionRules,
  subscribeRules,
  unsubscribeRules,
} from "../validators/push.validators.js";

/** /api/v1/push: Web Push subscriptions and preferences for the signed-in person. */
export const pushRouter = Router()
  // Public: the VAPID *public* key the browser subscribes with (the private key stays here).
  .get("/public-key", respond(() => push.publicConfig()))
  .use(authenticate)
  .post(
    "/subscriptions",
    createRateLimiter({
      windowMs: 15 * 60_000,
      limit: env.isTest ? 1000 : 30,
      message: "Too many attempts. Please try again later.",
    }),
    validate(subscribeRules),
    respond(
      (req) => push.subscribe(req.user._id, req.body, req.get("user-agent")),
      "Push notifications are on for this device",
      201,
    ),
  )
  .delete(
    "/subscriptions",
    validate(unsubscribeRules),
    respond(
      (req) => push.unsubscribe(req.user._id, req.body.endpoint),
      "Push notifications are off for this device",
    ),
  )
  .get("/preferences", respond((req) => push.getPreferences(req.user._id)))
  // FCM registration tokens of the native apps (for when they exist).
  .post(
    "/devices",
    validate([
      body("token").isString().trim().isLength({ min: 20, max: 500 }).withMessage("Invalid token"),
      body("platform").isIn(["android", "ios"]).withMessage("Platform must be android or ios"),
    ]),
    respond((req) => registerDevice(req.user._id, req.body), "Device registered", 201),
  )
  .delete(
    "/devices",
    validate([body("token").isString().trim().isLength({ min: 20, max: 500 })]),
    respond((req) => unregisterDevice(req.user._id, req.body.token)),
  )
  .put(
    "/preferences",
    validate(preferencesRules),
    respond(
      (req) => push.updatePreferences(req.user._id, req.body),
      "Notification preferences saved",
    ),
  );

/** /api/v1/admin/push: promotional pushes to customers who opted in. */
export const adminPushRouter = Router()
  .use(authenticate, can(PERMISSIONS.PROMOTIONS_SEND))
  .post(
    "/promotions",
    createRateLimiter({
      windowMs: 60 * 60_000,
      limit: env.isTest ? 1000 : 10,
      message: "Too many promotions sent. Please try again later.",
    }),
    validate(promotionRules),
    audited("push.promotion", "promotion", (req) => `Pushed promotion "${req.body.title}"`),
    respond((req) => push.sendPromotion(req.body), "Promotion is being sent"),
  );
