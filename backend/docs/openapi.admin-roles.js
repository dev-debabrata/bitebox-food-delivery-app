const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const ok = (description = "Success") => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          success: { const: true },
          message: { type: "string" },
          data: { type: "object" },
        },
      },
    },
  },
});
const err = (description) => ({
  description,
  content: { "application/json": { schema: ref("Error") } },
});
const body = (properties, required = []) => ({
  required: true,
  content: {
    "application/json": { schema: { type: "object", required, properties } },
  },
});
const bearer = [{ bearerAuth: [] }];
const id = { in: "path", name: "id", required: true, schema: { type: "string" } };
const q = (name, schema) => ({ in: "query", name, schema });
const paging = [
  q("page", { type: "integer", minimum: 1 }),
  q("limit", { type: "integer", minimum: 1, maximum: 100 }),
];
const days = q("days", { type: "integer", minimum: 1, maximum: 365, default: 30 });
const forbidden = { 401: err("Not signed in"), 403: err("Your role lacks this permission") };

/** One operation: tag, summary, who may call it, parameters, body and the success response. */
const op = (tag, summary, { params = [], requestBody, status = 200, who } = {}) => ({
  tags: [tag],
  summary,
  ...(who && { description: `Permission: \`${who}\`.` }),
  security: bearer,
  ...(params.length && { parameters: params }),
  ...(requestBody && { requestBody }),
  responses: { [status]: ok(), ...forbidden },
});

const STAFF_ROLES = ["operations_admin", "finance_admin", "support_admin"];
const TICKET_STATUS = ["open", "in_progress", "waiting_for_response", "resolved", "closed"];
const TICKET_TYPES = ["order_issue", "delivery", "payment", "refund", "account", "other"];
const PRIORITY = ["low", "medium", "high", "urgent"];

const A = "Admin - Admin management";
const O = "Admin - Operations";
const F = "Admin - Finance";
const S = "Admin - Support";
const H = "Support tickets";

export const adminRolesTags = [
  {
    name: A,
    description:
      "Super admin only: create and manage operations, finance and support admins; the audit log.",
  },
  { name: O, description: "Operations admins (and the super admin)." },
  { name: F, description: "Finance admins (and the super admin)." },
  { name: S, description: "Support admins (and the super admin)." },
  { name: H, description: "Customers, restaurants and riders raise and follow their tickets." },
];

export const adminRolesSchemas = {};

export const adminRolesPaths = {
  "/admin/admins": {
    get: op(A, "List admin accounts", {
      who: "admins:manage",
      params: [
        ...paging,
        q("role", { type: "string", enum: ["admin", ...STAFF_ROLES] }),
        q("status", { type: "string", enum: ["active", "suspended"] }),
        q("search", { type: "string" }),
      ],
    }),
    post: op(A, "Create an operations, finance or support admin", {
      who: "admins:manage",
      status: 201,
      requestBody: body(
        {
          name: { type: "string" },
          email: { type: "string", format: "email" },
          phone: { type: "string" },
          password: { type: "string", minLength: 8 },
          role: { type: "string", enum: STAFF_ROLES },
        },
        ["name", "email", "password", "role"],
      ),
    }),
  },
  "/admin/admins/{id}": {
    get: op(A, "One admin account", { who: "admins:manage", params: [id] }),
    patch: op(A, "Edit an admin (name, phone, role); a role change signs them out", {
      who: "admins:manage",
      params: [id],
      requestBody: body({
        name: { type: "string" },
        phone: { type: "string" },
        role: { type: "string", enum: STAFF_ROLES },
      }),
    }),
  },
  "/admin/admins/{id}/status": {
    patch: op(A, "Activate or deactivate an admin", {
      who: "admins:manage",
      params: [id],
      requestBody: body({ status: { type: "string", enum: ["active", "suspended"] } }, ["status"]),
    }),
  },
  "/admin/audit-logs": {
    get: op(A, "Audit log of important admin actions", {
      who: "audit:view",
      params: [
        ...paging,
        q("action", { type: "string" }),
        q("role", { type: "string" }),
        q("search", { type: "string" }),
        q("from", { type: "string", format: "date-time" }),
        q("to", { type: "string", format: "date-time" }),
      ],
    }),
  },

  "/admin/operations/dashboard": {
    get: op(O, "Order, restaurant and rider counts", { who: "operations:view", params: [days] }),
  },
  "/admin/operations/monitoring": {
    get: op(O, "Live orders with time in status; late ones first", { who: "operations:view" }),
  },
  "/admin/operations/restaurants": {
    get: op(O, "Restaurant availability and live order load", { who: "operations:view" }),
  },
  "/admin/operations/performance": {
    get: op(O, "Delivery times, stage averages and top riders", {
      who: "operations:view",
      params: [days],
    }),
  },

  "/admin/finance/dashboard": {
    get: op(F, "Revenue, payments, refunds, commission and money owed", {
      who: "finance:view",
      params: [days],
    }),
  },
  "/admin/finance/transactions/{id}": {
    get: op(F, "One payment with its order, customer and settlement", {
      who: "finance:view",
      params: [id],
    }),
  },
  "/admin/finance/commission": {
    get: op(F, "Commission rates and earnings per restaurant", {
      who: "finance:view",
      params: [days],
    }),
  },
  "/admin/finance/refunds": {
    get: op(F, "Refunded payments and refunds still needed", {
      who: "finance:view",
      params: [...paging, q("state", { type: "string", enum: ["needed", "refunded"] })],
    }),
  },
  "/admin/finance/payouts/due": {
    get: op(F, "What each restaurant or rider is owed", {
      who: "payouts:manage",
      params: [{ ...q("type", { type: "string", enum: ["restaurant", "rider"] }), required: true }],
    }),
  },
  "/admin/finance/payouts": {
    get: op(F, "Payout history", {
      who: "payouts:manage",
      params: [
        ...paging,
        q("type", { type: "string", enum: ["restaurant", "rider"] }),
        q("status", { type: "string", enum: ["pending", "paid", "cancelled"] }),
      ],
    }),
    post: op(F, "Create a payout for everything a payee is owed", {
      who: "payouts:manage",
      status: 201,
      requestBody: body(
        {
          type: { type: "string", enum: ["restaurant", "rider"] },
          payeeId: { type: "string", description: "Restaurant id or rider user id" },
          note: { type: "string" },
        },
        ["type", "payeeId"],
      ),
    }),
  },
  "/admin/finance/payouts/{id}/paid": {
    post: op(F, "Mark a pending payout as paid", {
      who: "payouts:manage",
      params: [id],
      requestBody: body({ reference: { type: "string" } }, ["reference"]),
    }),
  },
  "/admin/finance/payouts/{id}/cancel": {
    post: op(F, "Cancel a pending payout (its orders become due again)", {
      who: "payouts:manage",
      params: [id],
      requestBody: body({ note: { type: "string" } }),
    }),
  },

  "/admin/support/dashboard": {
    get: op(S, "Ticket counts", { who: "support:manage" }),
  },
  "/admin/support/staff": {
    get: op(S, "Admins a ticket can be assigned to", { who: "support:manage" }),
  },
  "/admin/support/tickets": {
    get: op(S, "The ticket queue", {
      who: "support:manage",
      params: [
        ...paging,
        q("status", { type: "string", enum: [...TICKET_STATUS, "active"] }),
        q("priority", { type: "string", enum: PRIORITY }),
        q("requesterRole", { type: "string", enum: ["customer", "restaurant", "delivery"] }),
        q("type", { type: "string", enum: TICKET_TYPES }),
        q("assignee", { type: "string", enum: ["me", "unassigned"] }),
        q("search", { type: "string" }),
      ],
    }),
  },
  "/admin/support/tickets/{id}": {
    get: op(S, "One ticket with conversation, notes and history", {
      who: "support:manage",
      params: [id],
    }),
    patch: op(S, "Change status, priority or assignee", {
      who: "support:manage",
      params: [id],
      requestBody: body({
        status: { type: "string", enum: TICKET_STATUS },
        priority: { type: "string", enum: PRIORITY },
        assigneeId: { type: "string", nullable: true },
        note: { type: "string" },
      }),
    }),
  },
  "/admin/support/tickets/{id}/messages": {
    post: op(S, "Reply to the requester, or add an internal note", {
      who: "support:manage",
      params: [id],
      requestBody: body({ body: { type: "string" }, internal: { type: "boolean" } }, ["body"]),
    }),
  },
  "/admin/support/tickets/{id}/escalate": {
    post: op(S, "Send a refund or payment issue to finance", {
      who: "support:manage",
      params: [id],
      requestBody: body({ note: { type: "string" } }, ["note"]),
    }),
  },

  "/support/tickets": {
    get: op(H, "My tickets", {
      params: [...paging, q("status", { type: "string", enum: ["open", "closed"] })],
    }),
    post: op(H, "Raise a ticket", {
      status: 201,
      requestBody: body(
        {
          type: { type: "string", enum: TICKET_TYPES },
          subject: { type: "string" },
          message: { type: "string" },
          orderNumber: { type: "string", example: "BB-261105-ABC123" },
        },
        ["type", "subject", "message"],
      ),
    }),
  },
  "/support/tickets/{id}": {
    get: op(H, "One of my tickets (no internal notes)", { params: [id] }),
  },
  "/support/tickets/{id}/messages": {
    post: op(H, "Reply on my ticket", {
      params: [id],
      requestBody: body({ body: { type: "string" } }, ["body"]),
    }),
  },
};
