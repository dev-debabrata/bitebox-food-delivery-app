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
const idParam = {
  in: "path",
  name: "id",
  required: true,
  schema: { type: "string" },
};
const foodParam = {
  in: "path",
  name: "foodItemId",
  required: true,
  schema: { type: "string" },
};
const addressQuery = {
  in: "query",
  name: "addressId",
  schema: { type: "string" },
  description: "Quote delivery to this address (default address if omitted)",
};
const paging = [
  { in: "query", name: "page", schema: { type: "integer", minimum: 1 } },
  {
    in: "query",
    name: "limit",
    schema: { type: "integer", minimum: 1, maximum: 100 },
  },
];
const quote = ok(ref("CartQuote"));
const T = {
  cart: ["Cart"],
  addr: ["Addresses"],
  orders: ["Orders"],
  coupons: ["Coupons"],
  admin: ["Admin - Coupons"],
};

const pricing = {
  type: "object",
  properties: {
    subtotalPaise: { type: "integer" },
    discountPaise: { type: "integer" },
    deliveryFeePaise: { type: "integer" },
    platformFeePaise: { type: "integer" },
    taxPaise: {
      type: "integer",
      description: "5% GST on the discounted subtotal",
    },
    totalPaise: { type: "integer" },
  },
};

const addressInput = {
  type: "object",
  properties: {
    label: { type: "string", enum: ["home", "work", "other"] },
    recipientName: { type: "string" },
    phone: { type: "string" },
    line1: { type: "string" },
    line2: { type: "string" },
    area: { type: "string" },
    landmark: { type: "string" },
    city: { type: "string" },
    state: { type: "string" },
    postalCode: { type: "string" },
    location: {
      type: "object",
      properties: {
        latitude: { type: "number" },
        longitude: { type: "number" },
      },
    },
    isDefault: { type: "boolean" },
  },
};

const couponInput = {
  type: "object",
  properties: {
    code: { type: "string", pattern: "^[A-Z0-9_-]{3,30}$" },
    description: { type: "string" },
    discountType: { type: "string", enum: ["percent", "flat"] },
    discountValue: {
      type: "integer",
      description: "percent: 1-100; flat: paise",
    },
    maxDiscountPaise: { type: ["integer", "null"] },
    minOrderPaise: { type: "integer" },
    validFrom: { type: "string", format: "date-time" },
    validUntil: { type: "string", format: "date-time" },
    isActive: { type: "boolean" },
    usageLimit: {
      type: ["integer", "null"],
      description: "Total uses across all customers; null = unlimited",
    },
    perUserLimit: { type: "integer" },
    restaurant: {
      type: ["string", "null"],
      description: "Restrict to one restaurant",
    },
  },
};

export const checkoutSchemas = {
  DeliveryAddress: {
    allOf: [
      addressInput,
      { type: "object", properties: { id: { type: "string" } } },
    ],
  },
  CartQuote: {
    type: "object",
    description:
      "Server-priced cart. canCheckout is false while any issue is present.",
    properties: {
      cart: {
        type: ["object", "null"],
        properties: {
          id: { type: "string" },
          restaurant: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              slug: { type: "string" },
              isOpenNow: { type: "boolean" },
              minOrderPaise: { type: "integer" },
            },
          },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                foodItemId: { type: "string" },
                name: { type: "string" },
                isVeg: { type: "boolean" },
                unitPricePaise: { type: "integer" },
                quantity: { type: "integer" },
                lineTotalPaise: { type: "integer" },
                isAvailable: { type: "boolean" },
              },
            },
          },
          itemCount: { type: "integer" },
        },
      },
      coupon: {
        type: ["object", "null"],
        properties: {
          code: { type: "string" },
          description: { type: "string" },
          discountPaise: { type: "integer" },
        },
      },
      couponError: {
        type: ["object", "null"],
        properties: { code: { type: "string" }, message: { type: "string" } },
      },
      address: { oneOf: [ref("DeliveryAddress"), { type: "null" }] },
      delivery: {
        type: ["object", "null"],
        properties: {
          distanceMeters: { type: "integer" },
          distanceKind: { const: "straight_line" },
          freeDelivery: { type: "boolean" },
        },
      },
      pricing,
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: {
              type: "string",
              enum: [
                "ITEMS_UNAVAILABLE",
                "RESTAURANT_UNAVAILABLE",
                "RESTAURANT_CLOSED",
                "BELOW_MINIMUM",
                "NO_ADDRESS",
                "OUT_OF_RANGE",
              ],
            },
            message: { type: "string" },
          },
        },
      },
      canCheckout: { type: "boolean" },
    },
  },
  Order: {
    type: "object",
    properties: {
      id: { type: "string" },
      orderNumber: { type: "string", example: "BB-261102-7KQ4XZ" },
      status: {
        type: "string",
        enum: [
          "pending",
          "confirmed",
          "rejected",
          "preparing",
          "ready_for_pickup",
          "assigned",
          "picked_up",
          "on_the_way",
          "delivered",
          "cancelled",
        ],
      },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            unitPricePaise: { type: "integer" },
            quantity: { type: "integer" },
            lineTotalPaise: { type: "integer" },
          },
        },
      },
      deliveryAddress: ref("DeliveryAddress"),
      restaurantSnapshot: {
        type: "object",
        properties: { name: { type: "string" }, slug: { type: "string" } },
      },
      pricing,
      coupon: {
        type: "object",
        properties: {
          code: { type: "string" },
          discountPaise: { type: "integer" },
        },
      },
      distanceMeters: {
        type: "integer",
        description: "Straight-line distance used for the delivery fee",
      },
      paymentMethod: { type: "string", enum: ["cod", "online"] },
      paymentStatus: {
        type: "string",
        enum: ["pending", "paid", "failed", "refunded", "cancelled"],
      },
      statusHistory: {
        type: "array",
        items: {
          type: "object",
          properties: {
            status: { type: "string" },
            at: { type: "string", format: "date-time" },
          },
        },
      },
      cancellation: {
        type: "object",
        description: "Set when rejected or cancelled",
        properties: {
          by: {
            type: "string",
            enum: ["customer", "restaurant", "admin", "system"],
          },
          reason: { type: "string" },
          at: { type: "string", format: "date-time" },
        },
      },
      rider: {
        type: ["object", "null"],
        description: "The assigned rider (customer and admin views)",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          phone: { type: "string" },
          vehicleType: { type: "string" },
          vehicleNumber: { type: "string" },
        },
      },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  Coupon: couponInput,
};

export const checkoutTags = [
  { name: "Cart" },
  { name: "Addresses" },
  { name: "Orders" },
  { name: "Coupons" },
  { name: "Admin - Coupons" },
];

export const checkoutPaths = {
  "/cart": {
    get: {
      tags: T.cart,
      summary: "My cart, priced by the server",
      security: bearer,
      parameters: [addressQuery],
      responses: { 200: quote, 403: err("Customers only") },
    },
    delete: {
      tags: T.cart,
      summary: "Empty my cart",
      security: bearer,
      parameters: [addressQuery],
      responses: { 200: quote },
    },
  },
  "/cart/items": {
    post: {
      tags: T.cart,
      summary: "Add a dish (quantity is added to any existing line)",
      security: bearer,
      parameters: [addressQuery],
      requestBody: body({
        type: "object",
        required: ["foodItemId"],
        properties: {
          foodItemId: { type: "string" },
          quantity: { type: "integer", minimum: 1, maximum: 20, default: 1 },
          replace: {
            type: "boolean",
            description: "Discard a cart from another restaurant",
          },
        },
      }),
      responses: {
        200: quote,
        404: err("Dish not found"),
        409: err("CART_RESTAURANT_CONFLICT or ITEM_UNAVAILABLE"),
      },
    },
  },
  "/cart/items/{foodItemId}": {
    patch: {
      tags: T.cart,
      summary: "Set a dish quantity (0 removes it)",
      security: bearer,
      parameters: [foodParam, addressQuery],
      requestBody: body({
        type: "object",
        required: ["quantity"],
        properties: { quantity: { type: "integer", minimum: 0, maximum: 20 } },
      }),
      responses: { 200: quote, 404: err("Not in cart") },
    },
    delete: {
      tags: T.cart,
      summary: "Remove a dish",
      security: bearer,
      parameters: [foodParam, addressQuery],
      responses: { 200: quote },
    },
  },
  "/cart/coupon": {
    post: {
      tags: T.cart,
      summary: "Apply a coupon code",
      security: bearer,
      parameters: [addressQuery],
      requestBody: body({
        type: "object",
        required: ["code"],
        properties: { code: { type: "string" } },
      }),
      responses: {
        200: quote,
        422: err(
          "COUPON_INVALID / COUPON_MIN_ORDER / COUPON_USED / COUPON_EXHAUSTED",
        ),
        429: err("Rate limited"),
      },
    },
    delete: {
      tags: T.cart,
      summary: "Remove the coupon",
      security: bearer,
      parameters: [addressQuery],
      responses: { 200: quote },
    },
  },
  "/addresses": {
    get: {
      tags: T.addr,
      summary: "My saved addresses (default first)",
      security: bearer,
      responses: {
        200: ok({
          type: "object",
          properties: {
            addresses: { type: "array", items: ref("DeliveryAddress") },
          },
        }),
      },
    },
    post: {
      tags: T.addr,
      summary: "Save an address (first one becomes default; max 10)",
      security: bearer,
      requestBody: body({
        ...addressInput,
        required: [
          "recipientName",
          "phone",
          "line1",
          "city",
          "state",
          "postalCode",
          "location",
        ],
      }),
      responses: {
        201: ok({
          type: "object",
          properties: { address: ref("DeliveryAddress") },
        }),
        409: err("Limit reached"),
        422: err("Validation failed"),
      },
    },
  },
  "/addresses/{id}": {
    patch: {
      tags: T.addr,
      summary: "Update an address",
      security: bearer,
      parameters: [idParam],
      requestBody: body(addressInput),
      responses: { 200: ok({ type: "object" }), 404: err("Not found") },
    },
    delete: {
      tags: T.addr,
      summary: "Delete an address",
      security: bearer,
      parameters: [idParam],
      responses: { 200: ok({ type: "null" }), 404: err("Not found") },
    },
  },
  "/addresses/{id}/default": {
    patch: {
      tags: T.addr,
      summary: "Make an address the default",
      security: bearer,
      parameters: [idParam],
      responses: { 200: ok({ type: "object" }), 404: err("Not found") },
    },
  },
  "/orders": {
    post: {
      tags: T.orders,
      summary: "Place an order from my cart",
      description:
        "Totals are recomputed on the server. Send the total the customer saw as expectedTotalPaise to get 409 PRICE_CHANGED instead of a surprise. Send an Idempotency-Key header so retries return the original order (200) instead of creating a duplicate.",
      security: bearer,
      parameters: [
        {
          in: "header",
          name: "Idempotency-Key",
          schema: { type: "string", minLength: 8, maxLength: 100 },
        },
      ],
      requestBody: body({
        type: "object",
        required: ["addressId", "paymentMethod"],
        properties: {
          addressId: { type: "string" },
          paymentMethod: { type: "string", enum: ["cod", "online"] },
          note: { type: "string", maxLength: 300 },
          expectedTotalPaise: { type: "integer" },
        },
      }),
      responses: {
        201: ok(
          { type: "object", properties: { order: ref("Order") } },
          "Order placed",
        ),
        200: ok(
          { type: "object", properties: { order: ref("Order") } },
          "Same Idempotency-Key: original order",
        ),
        400: err("Empty cart"),
        404: err("Address not found"),
        409: err(
          "CHECKOUT_BLOCKED / PRICE_CHANGED / CART_CHANGED / COUPON_INVALID / COUPON_EXHAUSTED",
        ),
      },
    },
    get: {
      tags: T.orders,
      summary: "My orders (newest first)",
      security: bearer,
      parameters: paging,
      responses: {
        200: ok({
          type: "object",
          properties: {
            items: { type: "array", items: ref("Order") },
            pagination: ref("Pagination"),
          },
        }),
      },
    },
  },
  "/orders/{id}": {
    get: {
      tags: T.orders,
      summary: "One of my orders (with the rider once assigned)",
      security: bearer,
      parameters: [idParam],
      responses: {
        200: ok({ type: "object", properties: { order: ref("Order") } }),
        404: err("Not found"),
      },
    },
  },
  "/coupons/available": {
    get: {
      tags: T.coupons,
      summary: "Coupons currently on offer",
      security: bearer,
      parameters: [
        { in: "query", name: "restaurantId", schema: { type: "string" } },
      ],
      responses: {
        200: ok({
          type: "object",
          properties: { coupons: { type: "array", items: ref("Coupon") } },
        }),
      },
    },
  },
  "/admin/coupons": {
    get: {
      tags: T.admin,
      summary: "All coupons",
      security: bearer,
      parameters: [
        ...paging,
        { in: "query", name: "search", schema: { type: "string" } },
        { in: "query", name: "active", schema: { type: "boolean" } },
      ],
      responses: { 200: ok({ type: "object" }), 403: err("Not an admin") },
    },
    post: {
      tags: T.admin,
      summary: "Create a coupon",
      security: bearer,
      requestBody: body({
        ...couponInput,
        required: [
          "code",
          "discountType",
          "discountValue",
          "validFrom",
          "validUntil",
        ],
      }),
      responses: {
        201: ok({ type: "object", properties: { coupon: ref("Coupon") } }),
        409: err("Code exists"),
        422: err("Validation failed"),
      },
    },
  },
  "/admin/coupons/{id}": {
    patch: {
      tags: T.admin,
      summary: "Update a coupon",
      security: bearer,
      parameters: [idParam],
      requestBody: body(couponInput),
      responses: { 200: ok({ type: "object" }), 404: err("Not found") },
    },
    delete: {
      tags: T.admin,
      summary: "Delete an unused coupon",
      security: bearer,
      parameters: [idParam],
      responses: {
        200: ok({ type: "null" }),
        409: err("Used; deactivate instead"),
      },
    },
  },
};
