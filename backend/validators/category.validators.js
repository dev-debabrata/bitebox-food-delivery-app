import { body } from "express-validator";
import { imageUrlBody, mongoIdParam } from "./common.validators.js";

function categoryRules({ partial }) {
  const field = (name) => (partial ? body(name).optional() : body(name));
  return [
    field("name").isString().trim().isLength({ min: 2, max: 50 }).withMessage("Name must be 2-50 characters"),
    body("description").optional().isString().trim().isLength({ max: 300 }),
    body("icon").optional().isString().trim().matches(/^[a-z0-9_]{1,40}$/).withMessage("Icon must be a Material Symbols name, e.g. local_pizza"),
    imageUrlBody(),
    body("sortOrder").optional().isInt({ min: 0, max: 10_000 }).toInt(),
    body("isActive").optional().isBoolean().toBoolean(),
  ];
}

export const createCategoryRules = categoryRules({ partial: false });
export const updateCategoryRules = [mongoIdParam(), ...categoryRules({ partial: true })];
