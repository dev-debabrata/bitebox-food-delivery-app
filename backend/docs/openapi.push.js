const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const ok = (data, description = "Success") => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: { success: { const: true }, message: { type: "string" }, data },
      },
    },
  },
});
const err = (description) => ({
  description,
  content: { "application/json": { schema: ref("Error") } },
});
const body = (schema) => ({ required: true, content: { "application/json": { schema } } });
const bearer = [{ bearerAuth: [] }];
const tags = ["Push notifications"];

export const pushTags = [
  {
    name: "Push notifications",
    description:
      "Web Push (VAPID). Every in-app notification is also pushed to the person's subscribed browsers, filtered by their preferences: `orders` (order and payment updates), `account` (everything else) and `promotions` (customers only, opt-in). Subscriptions must point at a known push service (`PUSH_ALLOWED_HOSTS`); expired ones (404/410) are removed automatically.",
  },
];

export const pushSchemas = {
  PushSubscriptionInput: {
    type: "object",
    required: ["endpoint", "keys"],
    properties: {
      endpoint: { type: "string", format: "uri", maxLength: 1000 },
      expirationTime: { type: ["integer", "null"] },
      keys: {
        type: "object",
        required: ["p256dh", "auth"],
        properties: { p256dh: { type: "string" }, auth: { type: "string" } },
      },
    },
  },
  PushPreferences: {
    type: "object",
    properties: {
      orders: { type: "boolean", default: true },
      account: { type: "boolean", default: true },
      promotions: { type: "boolean", default: false },
    },
  },
  PushSettings: {
    type: "object",
    properties: {
      preferences: ref("PushPreferences"),
      categories: { type: "array", items: { type: "string", enum: ["orders", "account", "promotions"] } },
      devices: { type: "integer", description: "Subscribed browsers for this account" },
      enabled: { type: "boolean", description: "Push is configured on the server" },
    },
  },
};

export const pushPaths = {
  "/push/public-key": {
    get: {
      tags,
      summary: "VAPID public key for subscribing (public)",
      responses: {
        200: ok({
          type: "object",
          properties: { enabled: { type: "boolean" }, publicKey: { type: ["string", "null"] } },
        }),
      },
    },
  },
  "/push/subscriptions": {
    post: {
      tags,
      summary: "Subscribe this browser (or move it to the signed-in account)",
      security: bearer,
      requestBody: body(ref("PushSubscriptionInput")),
      responses: {
        201: ok({ type: "object" }),
        401: err("Not signed in"),
        422: err("Invalid subscription or unsupported push service"),
        503: err("Push is not configured"),
      },
    },
    delete: {
      tags,
      summary: "Unsubscribe this browser from the signed-in account",
      security: bearer,
      requestBody: body({
        type: "object",
        required: ["endpoint"],
        properties: { endpoint: { type: "string", format: "uri" } },
      }),
      responses: { 200: ok({ type: "object", properties: { removed: { type: "boolean" } } }) },
    },
  },
  "/push/devices": {
    post: {
      tags,
      summary: "Register a native app's FCM token (for future apps)",
      security: bearer,
      requestBody: body({
        type: "object",
        required: ["token", "platform"],
        properties: { token: { type: "string" }, platform: { type: "string", enum: ["android", "ios"] } },
      }),
      responses: { 201: ok({ type: "object" }), 422: err("Validation failed") },
    },
    delete: {
      tags,
      summary: "Forget a native app's FCM token",
      security: bearer,
      requestBody: body({ type: "object", required: ["token"], properties: { token: { type: "string" } } }),
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/notifications/preferences": {
    get: {
      tags,
      summary: "Every channel's switches per category (push, email, SMS) and what is available",
      security: bearer,
      responses: { 200: ok({ type: "object" }) },
    },
    put: {
      tags,
      summary: "Change channel switches, e.g. { sms: { orders: true } }",
      security: bearer,
      requestBody: body({ type: "object" }),
      responses: { 200: ok({ type: "object" }), 422: err("Validation failed") },
    },
  },
  "/admin/notifications/deliveries": {
    get: {
      tags,
      summary: "Delivery log per channel: sent, failed (retrying), dead letters (operations:view)",
      security: bearer,
      parameters: [
        { in: "query", name: "status", schema: { type: "string", enum: ["queued", "sent", "failed", "dead", "skipped"] } },
        { in: "query", name: "channel", schema: { type: "string", enum: ["push", "fcm", "email", "sms"] } },
      ],
      responses: { 200: ok({ type: "object" }), 403: err("No permission") },
    },
  },
  "/admin/notifications/deliveries/{id}/retry": {
    post: {
      tags,
      summary: "Send a failed or dead delivery again",
      security: bearer,
      parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
      responses: { 200: ok({ type: "object" }), 409: err("Not failed or dead") },
    },
  },
  "/push/preferences": {
    get: {
      tags,
      summary: "Push preferences and number of subscribed devices",
      security: bearer,
      responses: { 200: ok(ref("PushSettings")) },
    },
    put: {
      tags,
      summary: "Change push preferences (send only the switches that change)",
      security: bearer,
      requestBody: body(ref("PushPreferences")),
      responses: { 200: ok(ref("PushSettings")), 422: err("Validation failed") },
    },
  },
  "/admin/push/promotions": {
    post: {
      tags,
      summary: "Push an offer to customers who opted in (permission promotions:send)",
      security: bearer,
      requestBody: body({
        type: "object",
        required: ["title", "body"],
        properties: {
          title: { type: "string", minLength: 3, maxLength: 60 },
          body: { type: "string", minLength: 3, maxLength: 160 },
          link: { type: "string", description: "A site path such as /restaurants" },
        },
      }),
      responses: {
        200: ok({ type: "object", properties: { recipients: { type: "integer" } } }),
        403: err("Missing permission"),
        503: err("Push is not configured"),
      },
    },
  },
};
