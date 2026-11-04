import { Router } from "express";
import * as auth from "../controllers/auth.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";
import {
  createRateLimiter,
  requireTrustedOrigin,
} from "../middleware/security.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import * as rules from "../validators/auth.validators.js";

export function createAuthRouter({
  authRateLimit = 20,
  sensitiveRateLimit = 5,
} = {}) {
  const router = Router();

  const authLimiter = createRateLimiter({
    windowMs: 15 * 60_000,
    limit: authRateLimit,
    message: "Too many attempts. Please try again in a few minutes.",
  });
  const sensitiveLimiter = createRateLimiter({
    windowMs: 15 * 60_000,
    limit: sensitiveRateLimit,
    message: "Too many password reset requests. Please try again later.",
  });

  router.post(
    "/register",
    authLimiter,
    validate(rules.registerRules),
    auth.register,
  );
  router.post("/login", authLimiter, validate(rules.loginRules), auth.login);
  router.post("/refresh", requireTrustedOrigin, auth.refresh);
  router.post("/logout", requireTrustedOrigin, auth.logout);
  router.post(
    "/forgot-password",
    sensitiveLimiter,
    validate(rules.forgotPasswordRules),
    auth.forgotPassword,
  );
  router.post(
    "/reset-password",
    sensitiveLimiter,
    validate(rules.resetPasswordRules),
    auth.resetPassword,
  );

  router.get("/me", authenticate, auth.me);
  router.patch(
    "/me",
    authenticate,
    validate(rules.updateProfileRules),
    auth.updateMe,
  );
  router.post(
    "/change-password",
    authenticate,
    authLimiter,
    validate(rules.changePasswordRules),
    auth.changePassword,
  );

  return router;
}
