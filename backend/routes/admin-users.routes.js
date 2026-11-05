import { Router } from "express";
import { body, query } from "express-validator";
import { PERMISSIONS } from "../config/permissions.js";
import { authenticate, can } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { MEMBER_ROLES, USER_STATUS } from "../models/user.model.js";
import {
  listMembers,
  setAccountStatus,
} from "../services/admin-staff.service.js";
import { audited } from "../services/audit.service.js";
import { respond } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";
import {
  mongoIdParam,
  paginationRules,
} from "../validators/common.validators.js";

/** /api/v1/admin/users: customers, restaurant partners and riders (admins live in /admin/admins). */
const router = Router().use(authenticate, can(PERMISSIONS.USERS_MANAGE));

router.get(
  "/",
  validate([
    query("role").optional().isIn(MEMBER_ROLES),
    query("status").optional().isIn(Object.values(USER_STATUS)),
    query("search").optional().isString().trim().isLength({ max: 100 }),
    ...paginationRules,
  ]),
  respond((req) =>
    listMembers(req.validatedQuery, parsePagination(req.validatedQuery)),
  ),
);

router.patch(
  "/:id/status",
  validate([
    mongoIdParam(),
    body("status")
      .isIn(Object.values(USER_STATUS))
      .withMessage(
        `Status must be one of: ${Object.values(USER_STATUS).join(", ")}`,
      ),
  ]),
  audited(
    "user.status",
    "user",
    (req) => `Set account status to ${req.body.status}`,
  ),
  respond(
    async (req) => ({
      user: await setAccountStatus(
        req.user._id,
        req.params.id,
        req.body.status,
        MEMBER_ROLES,
      ),
    }),
    (req) =>
      req.body.status === USER_STATUS.ACTIVE
        ? "User reactivated"
        : "User suspended",
  ),
);

export default router;
