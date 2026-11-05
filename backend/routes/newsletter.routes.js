import { Router } from "express";
import { body } from "express-validator";
import { env } from "../config/env.js";
import { createRateLimiter } from "../middleware/security.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import * as newsletter from "../services/newsletter.service.js";
import { respond } from "../utils/api-response.js";

/** /api/v1/newsletter: public sign-up (footer). Rate limited against spam. */
export const newsletterRouter = Router().post(
  "/subscriptions",
  createRateLimiter({
    windowMs: 15 * 60_000,
    limit: env.isTest ? 1000 : 10,
    message: "Too many sign-up attempts. Please try again later.",
  }),
  validate([
    body("email")
      .isString()
      .trim()
      .toLowerCase()
      .isLength({ max: 254 })
      .isEmail()
      .withMessage("Enter a valid email address"),
  ]),
  respond(
    (req) => newsletter.subscribe(req.body.email),
    (_req, data) => (data.alreadySubscribed ? "You're already subscribed" : "Subscribed"),
  ),
);
