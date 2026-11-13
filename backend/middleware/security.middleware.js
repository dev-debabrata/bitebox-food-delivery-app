import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
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

const hasNul = (value) =>
  typeof value === "string"
    ? value.includes("\u0000")
    : value !== null && typeof value === "object" && Object.values(value).some(hasNul); // arrays too

export function mongoSanitize(req, _res, next) {
  // A NUL character is never valid input, and MongoDB refuses it in regular expressions (500s).
  if (hasNul(req.query) || hasNul(req.body))
    return next(ApiError.badRequest("The request contains an invalid character"));
  if (req.body) stripOperators(req.body);
  if (req.params) stripOperators(req.params);
  next();
}

// Only the exact origins in CLIENT_URL. A wildcard here would let any site on the same
// host (e.g. any *.vercel.app page) read credentialed responses such as /auth/refresh.
export const isAllowedOrigin = (origin) =>
  !origin || env.clientUrls.includes(origin);

export function requireTrustedOrigin(req, _res, next) {
  const origin = req.get("origin");
  if (!isAllowedOrigin(origin)) {
    logger.warn(
      { origin, allowed: env.clientUrls },
      "Rejected auth request from an origin not listed in CLIENT_URL",
    );
    return next(ApiError.forbidden("Untrusted origin"));
  }
  if (req.get("x-requested-with") !== "BiteBox")
    return next(ApiError.forbidden("Missing CSRF header"));
  next();
}

/**
 * Lets the CDN (Vercel edge) share public catalogue reads: fresh for 60 s, then served stale
 * for up to 10 min while one request refreshes it in the background. Browsers always revalidate.
 */
export function publicCache(req, res, next) {
  if (req.method === "GET")
    res.set(
      "Cache-Control",
      "public, max-age=0, s-maxage=60, stale-while-revalidate=600",
    );
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
