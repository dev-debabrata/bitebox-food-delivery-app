const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const ok = (data, description = "Success") => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          success: { const: true },
          message: { type: "string" },
          data,
        },
      },
    },
  },
});
const err = (description) => ({
  description,
  content: { "application/json": { schema: ref("Error") } },
});
const body = (schema) => ({
  required: true,
  content: { "application/json": { schema } },
});
const bearer = [{ bearerAuth: [] }];
const orderId = {
  in: "path",
  name: "orderId",
  required: true,
  schema: { type: "string" },
};
const idParam = {
  in: "path",
  name: "id",
  required: true,
  schema: { type: "string" },
};
const days = {
  in: "query",
  name: "days",
  schema: { type: "integer", minimum: 1, maximum: 365, default: 30 },
};
const paging = [
  { in: "query", name: "page", schema: { type: "integer", minimum: 1 } },
  {
    in: "query",
    name: "limit",
    schema: { type: "integer", minimum: 1, maximum: 100 },
  },
];
const payment = ok({ type: "object", properties: { payment: ref("Payment") } });

export const paymentsTags = [
  {
    name: "Payments",
    description:
      "Cash on delivery, Razorpay (when configured) or the simulated provider (development only).",
  },
  { name: "Notifications" },
  { name: "Earnings" },
  { name: "Admin - Payments & reports" },
];

export const paymentsSchemas = {
  Payment: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["pending", "paid", "failed", "refunded", "partially_refunded", "cancelled"],
      },
      method: { type: "string", enum: ["cod", "online"] },
      provider: {
        type: "string",
        enum: ["cash_on_delivery", "razorpay", "mock"],
      },
      simulated: {
        type: "boolean",
        description:
          "true for the development-only mock provider: no real money moves",
      },
      amountPaise: { type: "integer" },
      paidAt: { type: ["string", "null"], format: "date-time" },
      refundedAt: { type: ["string", "null"], format: "date-time" },
      failureReason: { type: ["string", "null"] },
    },
  },
  Checkout: {
    type: "object",
    description: "What the browser needs to open the gateway checkout",
    properties: {
      provider: { type: "string" },
      simulated: { type: "boolean" },
      keyId: {
        type: "string",
        description: "Razorpay public key id (never the secret)",
      },
      providerOrderId: { type: "string" },
      amountPaise: { type: "integer" },
      currency: { type: "string" },
      orderNumber: { type: "string" },
    },
  },
  Notification: {
    type: "object",
    properties: {
      id: { type: "string" },
      type: { type: "string", example: "order.confirmed" },
      title: { type: "string" },
      body: { type: "string" },
      link: { type: "string" },
      readAt: { type: ["string", "null"], format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  Earnings: {
    type: "object",
    properties: {
      days: { type: "integer" },
      totals: {
        type: "object",
        properties: {
          orders: { type: "integer" },
          earningsPaise: { type: "integer" },
          distanceMeters: { type: "integer" },
        },
      },
      daily: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: { type: "string" },
            orders: { type: "integer" },
            earningsPaise: { type: "integer" },
          },
        },
      },
      recent: { type: "array", items: { type: "object" } },
    },
  },
};

export const paymentsPaths = {
  "/payments/methods": {
    get: {
      tags: ["Payments"],
      summary: "Payment methods offered at checkout",
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/payments/orders/{orderId}/start": {
    post: {
      tags: ["Payments"],
      summary: "Create (or reuse) the gateway order for an unpaid online order",
      security: bearer,
      parameters: [orderId],
      responses: {
        200: ok({ type: "object", properties: { checkout: ref("Checkout") } }),
        409: err("Already paid or order closed"),
        503: err("Gateway unavailable"),
      },
    },
  },
  "/payments/orders/{orderId}/confirm": {
    post: {
      tags: ["Payments"],
      summary:
        "Confirm a Razorpay checkout (signature verified, then the payment is fetched from Razorpay)",
      security: bearer,
      parameters: [orderId],
      requestBody: body({
        type: "object",
        required: ["providerPaymentId", "signature"],
        properties: {
          providerPaymentId: { type: "string" },
          signature: { type: "string" },
        },
      }),
      responses: {
        200: payment,
        400: err("SIGNATURE_INVALID or PAYMENT_MISMATCH"),
      },
    },
  },
  "/payments/orders/{orderId}/abandon": {
    post: {
      tags: ["Payments"],
      summary:
        "Customer closed the payment page: cancel the unpaid order and put its dishes back in the cart",
      description:
        "Idempotent. Abandoned attempts are not listed in the customer's orders. A payment that still arrives later is refunded.",
      security: bearer,
      parameters: [orderId],
      responses: {
        200: ok({
          type: "object",
          properties: { restored: { type: "boolean" } },
        }),
        409: err("ORDER_PLACED: already paid"),
      },
    },
  },
  "/payments/orders/{orderId}/mock": {
    post: {
      tags: ["Payments"],
      summary: "DEVELOPMENT ONLY: finish a simulated payment (no real money)",
      security: bearer,
      parameters: [orderId],
      requestBody: body({
        type: "object",
        required: ["outcome"],
        properties: {
          outcome: { type: "string", enum: ["success", "failure"] },
        },
      }),
      responses: {
        200: payment,
        400: err("Not a simulated payment"),
        409: err("Order closed"),
      },
    },
  },
  "/payments/webhooks/razorpay": {
    post: {
      tags: ["Payments"],
      summary:
        "Razorpay webhook (authenticated by the X-Razorpay-Signature HMAC over the raw body)",
      description:
        "Each event id (X-Razorpay-Event-Id) is applied once; replays are acknowledged and ignored.",
      responses: { 200: ok({ type: "object" }), 400: err("Invalid signature") },
    },
  },
  "/notifications": {
    get: {
      tags: ["Notifications"],
      summary: "My notifications (newest first) with the unread count",
      security: bearer,
      parameters: [
        ...paging,
        {
          in: "query",
          name: "unread",
          schema: { type: "boolean" },
          description: "Only unread ones",
        },
      ],
      responses: { 200: ok({ type: "object" }) },
    },
    delete: {
      tags: ["Notifications"],
      summary: "Clear all: delete all my notifications",
      security: bearer,
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/notifications/read-all": {
    post: {
      tags: ["Notifications"],
      summary: "Mark all my notifications read",
      security: bearer,
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/notifications/{id}/read": {
    patch: {
      tags: ["Notifications"],
      summary: "Mark one notification read",
      security: bearer,
      parameters: [idParam],
      responses: { 200: ok({ type: "object" }), 404: err("Not found") },
    },
  },
  "/my/restaurant/earnings": {
    get: {
      tags: ["Earnings"],
      summary:
        "My restaurant's earnings from delivered orders (after commission)",
      security: bearer,
      parameters: [days],
      responses: { 200: ok(ref("Earnings")) },
    },
  },
  "/delivery/earnings": {
    get: {
      tags: ["Earnings"],
      summary: "My delivery earnings",
      security: bearer,
      parameters: [days],
      responses: { 200: ok(ref("Earnings")) },
    },
  },
  "/admin/payments": {
    get: {
      tags: ["Admin - Payments & reports"],
      summary: "All payments",
      security: bearer,
      parameters: [
        { in: "query", name: "status", schema: { type: "string" } },
        { in: "query", name: "method", schema: { type: "string" } },
        { in: "query", name: "provider", schema: { type: "string" } },
        {
          in: "query",
          name: "orderState",
          schema: {
            type: "string",
            enum: ["active", "delivered", "cancelled"],
          },
          description: "Where the order stands; cancelled includes rejected",
        },
        ...paging,
      ],
      responses: { 200: ok({ type: "object" }), 403: err("Not an admin") },
    },
  },
  "/admin/payments/{id}/refund": {
    post: {
      tags: ["Admin - Payments & reports"],
      summary: "Retry a failed refund",
      security: bearer,
      parameters: [idParam],
      responses: { 200: payment, 409: err("Not refundable") },
    },
  },
  "/admin/payments/{id}": {
    get: {
      tags: ["Admin - Payments & reports"],
      summary: "One payment with its refunds and the gateway events applied to it",
      security: bearer,
      parameters: [idParam],
      responses: { 200: ok({ type: "object" }), 404: err("Not found") },
    },
  },
  "/admin/payments/{id}/refunds": {
    post: {
      tags: ["Admin - Payments & reports"],
      summary: "Refund all or part of a payment (refunds:manage)",
      description:
        "Online payments are refunded through the gateway; cash refunds wait to be paid by hand. An Idempotency-Key header makes a retried request safe.",
      security: bearer,
      parameters: [
        idParam,
        { in: "header", name: "Idempotency-Key", schema: { type: "string" } },
      ],
      requestBody: body({
        type: "object",
        required: ["amountPaise", "reason"],
        properties: {
          amountPaise: { type: "integer", minimum: 1 },
          reason: { type: "string", maxLength: 300 },
        },
      }),
      responses: {
        200: ok({ type: "object" }),
        409: err("Not paid, or more than is left (REFUND_TOO_LARGE)"),
        422: err("Invalid amount or reason"),
      },
    },
  },
  "/admin/refunds/{id}/paid": {
    post: {
      tags: ["Admin - Payments & reports"],
      summary: "Mark a cash refund as paid back by hand",
      security: bearer,
      parameters: [idParam],
      responses: { 200: ok({ type: "object" }), 409: err("Not a pending cash refund") },
    },
  },
  "/payments/mine": {
    get: {
      tags: ["Payments"],
      summary: "My payments and their refunds",
      security: bearer,
      parameters: paging,
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/delivery/stats": {
    get: {
      tags: ["Earnings"],
      summary: "Rider: today, this week and all-time deliveries and earnings, and the rating",
      security: bearer,
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/admin/reports": {
    get: {
      tags: ["Admin - Payments & reports"],
      summary:
        "Platform analytics: totals, daily trend, payment mix, statuses, top restaurants",
      security: bearer,
      parameters: [days],
      responses: { 200: ok({ type: "object" }), 403: err("Not an admin") },
    },
  },
};
