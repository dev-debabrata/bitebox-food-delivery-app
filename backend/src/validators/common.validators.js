import { body, param, query } from "express-validator";

export const mongoIdParam = (name = "id") => param(name).isMongoId().withMessage("Invalid id");

export const paginationRules = [
  query("page").optional().isInt({ min: 1, max: 10_000 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
];

export const searchQuery = () => query("search").optional().isString().trim().isLength({ max: 100 });

export const booleanQuery = (name) => query(name).optional().isBoolean().withMessage(`${name} must be true or false`).toBoolean();

/** Optional absolute http(s) image URL (e.g. returned by the upload endpoint). Empty string clears it. */
export const imageUrlBody = (field = "imageUrl") =>
  body(field)
    .optional({ values: "null" })
    .isString()
    .trim()
    // No quotes, parentheses, backslashes or angle brackets: the URL is also used inside CSS url().
    .custom((value) => value === "" || /^https?:\/\/[^\s"'()\\<>]{1,490}$/i.test(value))
    .withMessage("Image must be an http(s) URL");

/** Amounts are integer paise (₹1 = 100). */
export const paiseBody = (field, { optional = false, min = 0, max = 10_000_000 } = {}) => {
  const chain = body(field);
  return (optional ? chain.optional() : chain)
    .isInt({ min, max })
    .withMessage(`${field} must be a whole number of paise between ${min} and ${max}`)
    .toInt();
};
