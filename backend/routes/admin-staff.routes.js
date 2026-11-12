import { Router } from "express";
import { PERMISSIONS } from "../config/permissions.js";
import { authenticate, can } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { ADMIN_ROLES, ROLE_LABEL } from "../config/roles.js";
import * as staff from "../services/admin-staff.service.js";
import * as audit from "../services/audit.service.js";
import { respond } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";
import { mongoIdParam, paginationRules } from "../validators/common.validators.js";
import * as rules from "../validators/admin-staff.validators.js";

/** /api/v1/admin/admins: the super admin creates and manages operations, finance and support admins. */
export const adminStaffRouter = Router()
  .use(authenticate, can(PERMISSIONS.ADMINS_MANAGE))
  .get(
    "/",
    validate(rules.listStaffRules),
    respond((req) =>
      staff.listStaff(req.validatedQuery, parsePagination(req.validatedQuery)),
    ),
  )
  .get(
    "/:id",
    validate([mongoIdParam()]),
    respond(async (req) => ({ user: await staff.getStaff(req.params.id) })),
  )
  // Sign-ins of a staff admin (admin security: login history).
  .get(
    "/:id/logins",
    validate([mongoIdParam(), ...paginationRules]),
    respond((req) =>
      staff.loginHistory(req.params.id, ADMIN_ROLES, parsePagination(req.validatedQuery)),
    ),
  )
  .post(
    "/",
    validate(rules.createStaffRules),
    audit.audited(
      "admin.create",
      "user",
      (req) => `Created ${ROLE_LABEL[req.body.role]} ${req.body.email}`,
    ),
    respond(
      async (req) => {
        const user = await staff.createStaff(req.body);
        req.auditResourceId = user.id;
        return { user };
      },
      "Admin created",
      201,
    ),
  )
  .patch(
    "/:id",
    validate(rules.updateStaffRules),
    audit.audited("admin.update", "user", (req) =>
      req.body.role
        ? `Updated admin; role set to ${ROLE_LABEL[req.body.role]}`
        : "Updated admin details",
    ),
    respond(
      async (req) => ({
        user: await staff.updateStaff(req.user._id, req.params.id, req.body),
      }),
      "Admin updated",
    ),
  )
  .patch(
    "/:id/status",
    validate(rules.staffStatusRules),
    audit.audited("admin.status", "user", (req) =>
      req.body.status === "active" ? "Activated admin" : "Deactivated admin",
    ),
    respond(
      async (req) => ({
        user: await staff.setAccountStatus(
          req.user._id,
          req.params.id,
          req.body.status,
          ADMIN_ROLES,
        ),
      }),
      (req) =>
        req.body.status === "active" ? "Admin activated" : "Admin deactivated",
    ),
  );

/** /api/v1/admin/audit-logs: important admin actions, newest first. */
export const adminAuditRouter = Router()
  .use(authenticate, can(PERMISSIONS.AUDIT_VIEW))
  .get(
    "/",
    validate(rules.auditListRules),
    respond((req) =>
      audit.list(req.validatedQuery, parsePagination(req.validatedQuery)),
    ),
  );
