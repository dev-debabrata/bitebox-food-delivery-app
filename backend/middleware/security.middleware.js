import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";
import { ApiError } from "../utils/api-error.js";

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

export const isAllowedOrigin = (origin) =>
  !origin ||
  env.clientUrls.includes("*") ||
  env.clientUrls.includes(origin) ||
  /^https:\/\/.*\.vercel\.app$/.test(origin);

export function requireTrustedOrigin(req, _res, next) {
  const origin = req.get("origin");
  if (!isAllowedOrigin(origin))
    return next(ApiError.forbidden("Untrusted origin"));
  if (req.get("x-requested-with") !== "BiteBox")
    return next(ApiError.forbidden("Missing CSRF header"));
  next();
}

export const createRateLimiter = ({ windowMs, limit, message }) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new ApiError(429, message, { code: "RATE_LIMITED" })),
  });
