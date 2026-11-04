import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";
import { ApiError } from "../utils/api-error.js";

/**
 * Removes keys that MongoDB would interpret as operators ("$gt") or paths
 * ("a.b") from request bodies and route params (NoSQL-injection defence).
 * Express 5's default query parser never produces nested objects, so query
 * values are always plain strings.
 */
function stripOperators(value) {
  if (Array.isArray(value)) return value.map(stripOperators);
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (key.startsWith("$") || key.includes(".")) delete value[key];
      else value[key] = stripOperators(value[key]);
    }
  }
  return value;
}

export function mongoSanitize(req, _res, next) {
  if (req.body) stripOperators(req.body);
  if (req.params) stripOperators(req.params);
  next();
}

/**
 * CSRF defence for cookie-authenticated endpoints (refresh/logout):
 * the request must carry our custom header (which forces a CORS preflight)
 * and, when the browser sends an Origin, it must be allow-listed.
 */
export function requireTrustedOrigin(req, _res, next) {
  const origin = req.get("origin");
  if (origin && !env.clientUrls.includes(origin)) return next(ApiError.forbidden("Untrusted origin"));
  if (req.get("x-requested-with") !== "BiteBox") return next(ApiError.forbidden("Missing CSRF header"));
  next();
}

export const createRateLimiter = ({ windowMs, limit, message }) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new ApiError(429, message, { code: "RATE_LIMITED" })),
  });
