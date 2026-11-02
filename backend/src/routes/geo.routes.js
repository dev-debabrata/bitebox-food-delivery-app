import { Router } from "express";
import { query } from "express-validator";
import { env } from "../config/env.js";
import { createRateLimiter } from "../middleware/security.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { authenticate } from "../middleware/auth.middleware.js";
import * as geocoding from "../services/geocoding.service.js";
import * as routing from "../services/routing.service.js";
import { sendSuccess } from "../utils/api-response.js";

/** /api/v1/geo: place search, reverse geocoding and road routes (proxied, cached, throttled). */
const router = Router();
router.use(createRateLimiter({ windowMs: 60_000, limit: env.isTest ? 1000 : 30, message: "Too many location lookups. Please wait a moment." }));

router.get("/search", validate([query("q").isString().trim().isLength({ min: 3, max: 120 }).withMessage("Type at least 3 characters")]), async (req, res) => {
  sendSuccess(res, { data: { places: await geocoding.search(req.validatedQuery.q) } });
});

router.get(
  "/reverse",
  validate([
    query("lat").isFloat({ min: -90, max: 90 }).withMessage("Invalid latitude").toFloat(),
    query("lng").isFloat({ min: -180, max: 180 }).withMessage("Invalid longitude").toFloat(),
  ]),
  async (req, res) => {
    sendSuccess(res, { data: { place: await geocoding.reverse(req.validatedQuery.lat, req.validatedQuery.lng) } });
  },
);

const point = (prefix) => [
  query(`${prefix}Lat`).isFloat({ min: -90, max: 90 }).withMessage(`Invalid ${prefix} latitude`).toFloat(),
  query(`${prefix}Lng`).isFloat({ min: -180, max: 180 }).withMessage(`Invalid ${prefix} longitude`).toFloat(),
];

/**
 * GET /geo/route?fromLat=&fromLng=&toLat=&toLng=  (signed-in users only, so the
 * routing provider cannot be used as an open proxy). Road distance, estimated
 * duration and the path to draw; 503 ROUTING_UNAVAILABLE means "draw a straight line".
 */
router.get("/route", authenticate, validate([...point("from"), ...point("to")]), async (req, res) => {
  const { fromLat, fromLng, toLat, toLng } = req.validatedQuery;
  const result = await routing.route({ latitude: fromLat, longitude: fromLng }, { latitude: toLat, longitude: toLng });
  sendSuccess(res, { data: { route: result } });
});

export default router;
