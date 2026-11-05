import { Router } from "express";
import { PERMISSIONS } from "../config/permissions.js";
import { authenticate, authorize, can } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { ROLES } from "../models/user.model.js";
import { audited } from "../services/audit.service.js";
import * as support from "../services/support.service.js";
import { respond } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";
import { mongoIdParam } from "../validators/common.validators.js";
import * as rules from "../validators/support.validators.js";

/** /api/v1/support/tickets: customers, restaurants and riders raise and follow their own tickets. */
export const supportRouter = Router()
  .use(authenticate, authorize(ROLES.CUSTOMER, ROLES.RESTAURANT, ROLES.DELIVERY))
  .get(
    "/tickets",
    validate(rules.myTicketListRules),
    respond((req) =>
      support.listMine(req.user, req.validatedQuery, parsePagination(req.validatedQuery)),
    ),
  )
  .post(
    "/tickets",
    validate(rules.createTicketRules),
    respond(
      async (req) => ({ ticket: await support.create(req.user, req.body) }),
      "Ticket created. Our support team will reply soon.",
      201,
    ),
  )
  .get(
    "/tickets/:id",
    validate([mongoIdParam()]),
    respond(async (req) => ({ ticket: await support.getMine(req.user, req.params.id) })),
  )
  .post(
    "/tickets/:id/messages",
    validate(rules.replyRules),
    respond(
      async (req) => ({
        ticket: await support.replyMine(req.user, req.params.id, req.body.body),
      }),
      "Reply sent",
    ),
  );

/** /api/v1/admin/support: the support queue, ticket handling and the support dashboard. */
export const adminSupportRouter = Router()
  .use(authenticate, can(PERMISSIONS.SUPPORT_MANAGE))
  .get("/dashboard", respond(() => support.dashboard()))
  .get("/staff", respond(() => support.staffList()))
  .get(
    "/tickets",
    validate(rules.staffListRules),
    respond((req) =>
      support.list(req.user, req.validatedQuery, parsePagination(req.validatedQuery)),
    ),
  )
  .get(
    "/tickets/:id",
    validate([mongoIdParam()]),
    respond(async (req) => ({ ticket: await support.get(req.params.id) })),
  )
  .patch(
    "/tickets/:id",
    validate(rules.updateTicketRules),
    audited("ticket.update", "ticket", (req) =>
      Object.entries({
        status: req.body.status,
        priority: req.body.priority,
        assignee: req.body.assigneeId === undefined ? undefined : req.body.assigneeId || "none",
      })
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k} → ${v}`)
        .join(", ") || "Updated ticket",
    ),
    respond(
      async (req) => ({ ticket: await support.update(req.user, req.params.id, req.body) }),
      "Ticket updated",
    ),
  )
  .post(
    "/tickets/:id/messages",
    validate(rules.staffMessageRules),
    respond(
      async (req) => ({ ticket: await support.addMessage(req.user, req.params.id, req.body) }),
      (req) => (req.body.internal ? "Note added" : "Reply sent"),
    ),
  )
  .post(
    "/tickets/:id/escalate",
    validate(rules.escalateRules),
    audited("ticket.escalate", "ticket", (req) => `Escalated to finance: ${req.body.note}`),
    respond(
      async (req) => ({
        ticket: await support.escalateToFinance(req.user, req.params.id, req.body.note),
      }),
      "Sent to the finance team",
    ),
  );
