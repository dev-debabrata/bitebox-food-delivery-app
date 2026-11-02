import mongoose from "mongoose";
import { env } from "../config/env.js";
import { ApiError } from "../utils/api-error.js";

export const notFound = (req, _res, next) => next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));

/** Converts known library errors into safe ApiErrors. */
function normalise(err) {
  if (err instanceof ApiError) return err;

  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    return new ApiError(422, "Validation failed", { code: "VALIDATION_ERROR", details });
  }
  if (err instanceof mongoose.Error.CastError) {
    return ApiError.badRequest(`Invalid value for ${err.path}`);
  }
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? "field";
    return ApiError.conflict(`A record with this ${field} already exists`);
  }
  if (err?.type === "entity.parse.failed") return ApiError.badRequest("Malformed JSON body");
  if (err?.type === "entity.too.large") return new ApiError(413, "Request body is too large", { code: "PAYLOAD_TOO_LARGE" });

  return null;
}

// Express identifies error handlers by their 4-argument signature.
export function errorHandler(err, req, res, _next) {
  const apiError = normalise(err);

  if (!apiError) {
    req.log?.error({ err }, "Unhandled error");
    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again later.",
      error: { code: "INTERNAL_ERROR", ...(!env.isProduction && { debug: err?.message }) },
    });
  }

  if (apiError.statusCode >= 500) req.log?.error({ err }, apiError.message);

  res.status(apiError.statusCode).json({
    success: false,
    message: apiError.message,
    error: { code: apiError.code ?? "ERROR", ...(apiError.details && { details: apiError.details }) },
  });
}
