import { body, query } from "express-validator";
import {
  ADMIN_ROLES,
  STAFF_ADMIN_ROLES,
  USER_STATUS,
} from "../models/user.model.js";
import { email, name, newPassword, phone } from "./auth.validators.js";
import { mongoIdParam, paginationRules } from "./common.validators.js";

const listQuery = [
  ...paginationRules,
  query("search").optional().isString().trim().isLength({ max: 100 }),
];
const staffRole = (optional = false) => {
  const rule = body("role");
  return (optional ? rule.optional() : rule)
    .isIn(STAFF_ADMIN_ROLES)
    .withMessage("Choose an operations, finance or support role");
};

export const listStaffRules = [
  ...listQuery,
  query("role").optional().isIn(ADMIN_ROLES),
  query("status").optional().isIn(Object.values(USER_STATUS)),
];
export const createStaffRules = [name(), email(), phone(), newPassword(), staffRole()];
export const updateStaffRules = [
  mongoIdParam(),
  name().optional(),
  phone(),
  staffRole(true),
];
export const staffStatusRules = [
  mongoIdParam(),
  body("status").isIn(Object.values(USER_STATUS)),
];

export const auditListRules = [
  ...listQuery,
  query("action").optional().isString().trim().isLength({ max: 60 }),
  query("role").optional().isIn(ADMIN_ROLES),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
];
