import { matchedData, validationResult } from "express-validator";
import { ApiError } from "../utils/api-error.js";

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype;

function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      const cleaned = compact(v);
      const emptyObject =
        isPlainObject(cleaned) && Object.keys(cleaned).length === 0;
      if (cleaned !== undefined && !emptyObject) out[key] = cleaned;
    }
    return out;
  }
  return value;
}

export const validate = (chains) => [
  ...chains,
  (req, _res, next) => {
    const result = validationResult(req);
    if (!result.isEmpty()) {
      const details = result
        .array({ onlyFirstError: true })
        .map((e) => ({ field: e.path, message: e.msg }));
      return next(
        new ApiError(422, "Validation failed", {
          code: "VALIDATION_ERROR",
          details,
        }),
      );
    }
    req.body = compact(
      matchedData(req, { locations: ["body"], includeOptionals: false }),
    );
    req.validatedQuery = compact(
      matchedData(req, { locations: ["query"], includeOptionals: false }),
    );
    next();
  },
];
