/**
 * OpenAPI fragments for Phase 4 (order handling, dispatch, riders).
 * The full transition table lives in services/order-workflow.service.js.
 */
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const ok = (data, description = "Success") => ({
  description,
  content: { "application/json": { schema: { type: "object", properties: { success: { const: true }, message: { type: "string" }, data } } } },
});
const err = (description) => ({ description, content: { "application/json": { schema: ref("Error") } } });
const body = (schema) => ({ required: true, content: { "application/json": { schema } } });
const bearer = [{ bearerAuth: [] }];
const idParam = { in: "path", name: "id", required: true, schema: { type: "string" } };
const paging = [
  { in: "query", name: "page", schema: { type: "integer", minimum: 1 } },
  { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
];
const T = { orders: ["Orders"], restaurant: ["Restaurant - Orders"], rider: ["Delivery"], admin: ["Admin - Orders"], adminRiders: ["Admin - Delivery partners"] };
const order = ok({ type: "object", properties: { order: ref("Order") } });
const conflict = err("Not allowed in the order's current status (INVALID_TRANSITION) or changed concurrently (ORDER_CHANGED)");
const reason = (required) => ({ type: "object", ...(required ? { required: ["reason"] } : {}), properties: { reason: { type: "string", maxLength: 300 } } });
const riderDashboard = ok(ref("RiderDashboard"));

export const ordersTags = [
  { name: "Restaurant - Orders", description: "A partner's incoming orders: accept/reject, preparing, ready for pickup." },
  { name: "Delivery", description: "The signed-in rider: availability, location, offers and their deliveries." },
  { name: "Admin - Orders" },
  { name: "Admin - Delivery partners" },
];

export const ordersSchemas = {
  RiderProfile: {
    type: "object",
    properties: {
      id: { type: "string" },
      vehicleType: { type: "string", enum: ["bicycle", "scooter", "motorbike", "car"] },
      vehicleNumber: { type: "string" },
      isOnline: { type: "boolean" },
      locationUpdatedAt: { type: "string", format: "date-time" },
      completedDeliveries: { type: "integer" },
    },
  },
  RiderDashboard: {
    type: "object",
    properties: {
      profile: ref("RiderProfile"),
      offer: { description: "Delivery currently offered to this rider (with offerExpiresAt), or null", oneOf: [ref("Order"), { type: "null" }] },
      activeOrder: { description: "The order this rider is carrying, or null", oneOf: [ref("Order"), { type: "null" }] },
    },
  },
};

export const ordersPaths = {
  "/orders/{id}/cancel": {
    post: {
      tags: T.orders,
      summary: "Cancel my order (only while the restaurant has not accepted it)",
      security: bearer,
      parameters: [idParam],
      requestBody: body(reason(false)),
      responses: { 200: order, 404: err("Not found"), 409: conflict },
    },
  },

  "/my/restaurant/orders": {
    get: {
      tags: T.restaurant,
      summary: "My restaurant's orders",
      description: "view=active (default): in-progress orders, oldest first, plus counts per status. view=history: finished orders, paginated.",
      security: bearer,
      parameters: [
        { in: "query", name: "view", schema: { type: "string", enum: ["active", "history"] } },
        { in: "query", name: "status", schema: { type: "string" } },
        ...paging,
      ],
      responses: { 200: ok({ type: "object" }), 403: err("Not a restaurant partner") },
    },
  },
  "/my/restaurant/orders/{id}": {
    get: { tags: T.restaurant, summary: "One order (customer phone and exact address hidden)", security: bearer, parameters: [idParam], responses: { 200: order, 404: err("Not found") } },
  },
  "/my/restaurant/orders/{id}/status": {
    patch: {
      tags: T.restaurant,
      summary: "Accept, reject, start preparing or mark ready for pickup",
      description: "pending -> confirmed | rejected (reason required); confirmed -> preparing; preparing -> ready_for_pickup (starts rider dispatch). Repeating the current status is a no-op.",
      security: bearer,
      parameters: [idParam],
      requestBody: body({ type: "object", required: ["status"], properties: { status: { type: "string", enum: ["confirmed", "rejected", "preparing", "ready_for_pickup"] }, reason: { type: "string" } } }),
      responses: { 200: order, 400: err("Reason missing"), 404: err("Not found"), 409: conflict },
    },
  },

  "/delivery/me": {
    get: { tags: T.rider, summary: "My profile, current offer and active delivery", security: bearer, responses: { 200: riderDashboard, 403: err("Not a delivery partner") } },
  },
  "/delivery/me/vehicle": {
    put: {
      tags: T.rider,
      summary: "Set my vehicle (required before going online)",
      security: bearer,
      requestBody: body({ type: "object", required: ["vehicleType"], properties: { vehicleType: { type: "string", enum: ["bicycle", "scooter", "motorbike", "car"] }, vehicleNumber: { type: "string" } } }),
      responses: { 200: ok({ type: "object", properties: { profile: ref("RiderProfile") } }), 422: err("Validation failed") },
    },
  },
  "/delivery/me/availability": {
    patch: {
      tags: T.rider,
      summary: "Go online (with current location) or offline",
      security: bearer,
      requestBody: body({ type: "object", required: ["isOnline"], properties: { isOnline: { type: "boolean" }, latitude: { type: "number" }, longitude: { type: "number" } } }),
      responses: { 200: riderDashboard, 400: err("Vehicle or location missing"), 409: err("Cannot go offline mid-delivery") },
    },
  },
  "/delivery/me/location": {
    put: {
      tags: T.rider,
      summary: "Report my position (online riders only; rate limited)",
      security: bearer,
      requestBody: body({ type: "object", required: ["latitude", "longitude"], properties: { latitude: { type: "number" }, longitude: { type: "number" } } }),
      responses: { 200: ok({ type: "object" }), 409: err("Offline"), 429: err("Too frequent") },
    },
  },
  "/delivery/offers/{id}/accept": {
    post: { tags: T.rider, summary: "Accept the delivery offered to me", security: bearer, parameters: [idParam], responses: { 200: riderDashboard, 409: err("Offer expired, withdrawn or not mine (OFFER_UNAVAILABLE)") } },
  },
  "/delivery/offers/{id}/decline": {
    post: { tags: T.rider, summary: "Decline the delivery offered to me (it goes to the next rider)", security: bearer, parameters: [idParam], responses: { 200: riderDashboard, 409: err("No such offer") } },
  },
  "/delivery/orders/{id}/status": {
    patch: {
      tags: T.rider,
      summary: "Picked up -> on the way -> delivered (my delivery only)",
      security: bearer,
      parameters: [idParam],
      requestBody: body({ type: "object", required: ["status"], properties: { status: { type: "string", enum: ["picked_up", "on_the_way", "delivered"] } } }),
      responses: { 200: riderDashboard, 404: err("Not my delivery"), 409: conflict },
    },
  },
  "/delivery/orders/history": {
    get: { tags: T.rider, summary: "My finished deliveries", security: bearer, parameters: paging, responses: { 200: ok({ type: "object" }) } },
  },

  "/admin/orders": {
    get: {
      tags: T.admin,
      summary: "All orders, with counts per status",
      security: bearer,
      parameters: [{ in: "query", name: "status", schema: { type: "string", description: "An order status, or 'active'" } }, { in: "query", name: "search", schema: { type: "string" }, description: "Order number" }, ...paging],
      responses: { 200: ok({ type: "object" }), 403: err("Not an admin") },
    },
  },
  "/admin/orders/{id}": {
    get: { tags: T.admin, summary: "One order, with rider and current offer", security: bearer, parameters: [idParam], responses: { 200: order, 404: err("Not found") } },
  },
  "/admin/orders/{id}/cancel": {
    post: { tags: T.admin, summary: "Cancel an order (not once picked up)", security: bearer, parameters: [idParam], requestBody: body(reason(true)), responses: { 200: order, 409: conflict, 422: err("Reason required") } },
  },
  "/admin/orders/{id}/unassign": {
    post: { tags: T.admin, summary: "Take an assigned order back from its rider and re-dispatch it", security: bearer, parameters: [idParam], requestBody: body(reason(false)), responses: { 200: order, 409: conflict } },
  },
  "/admin/delivery-partners": {
    get: {
      tags: T.adminRiders,
      summary: "Delivery partners with availability and current delivery",
      security: bearer,
      parameters: [{ in: "query", name: "search", schema: { type: "string" } }, { in: "query", name: "online", schema: { type: "boolean" } }, ...paging],
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/admin/delivery-partners/{id}/status": {
    patch: {
      tags: T.adminRiders,
      summary: "Suspend or reactivate a rider (not while carrying an order)",
      security: bearer,
      parameters: [idParam],
      requestBody: body({ type: "object", required: ["status"], properties: { status: { type: "string", enum: ["active", "suspended"] } } }),
      responses: { 200: ok({ type: "object" }), 404: err("Not found"), 409: err("Rider is mid-delivery") },
    },
  },
};
