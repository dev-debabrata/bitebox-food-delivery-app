/**
 * OpenAPI fragments for Phase 2 (restaurants, categories, food, uploads).
 * Merged into the main document in openapi.js. All money fields are integer paise.
 */
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const ok = (data, description = "Success") => ({
  description,
  content: {
    "application/json": {
      schema: { type: "object", properties: { success: { const: true }, message: { type: "string" }, data } },
    },
  },
});
const err = (description) => ({ description, content: { "application/json": { schema: ref("Error") } } });
const body = (schema) => ({ required: true, content: { "application/json": { schema } } });
const idParam = { in: "path", name: "id", required: true, schema: { type: "string", pattern: "^[a-f0-9]{24}$" } };
const q = (name, schema, description) => ({ in: "query", name, schema, ...(description && { description }) });
const paging = [q("page", { type: "integer", minimum: 1 }), q("limit", { type: "integer", minimum: 1, maximum: 100 })];
const paged = (item) => ({ type: "object", properties: { items: { type: "array", items: item }, pagination: ref("Pagination") } });
const bearer = [{ bearerAuth: [] }];
const paise = (description) => ({ type: "integer", minimum: 0, description: `${description} (integer paise, ₹1 = 100)` });

const restaurantInput = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 2, maxLength: 100 },
    description: { type: "string", maxLength: 1000 },
    cuisines: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" } },
    phone: { type: "string", pattern: "^\\+?[0-9]{10,15}$" },
    email: { type: "string", format: "email" },
    address: ref("Address"),
    location: {
      type: "object",
      required: ["latitude", "longitude"],
      properties: { latitude: { type: "number", minimum: -90, maximum: 90 }, longitude: { type: "number", minimum: -180, maximum: 180 } },
    },
    imageUrl: { type: "string", format: "uri" },
    isPureVeg: { type: "boolean" },
    costForTwoPaise: paise("Average cost for two"),
    minOrderPaise: paise("Minimum order value"),
    avgPrepTimeMinutes: { type: "integer", minimum: 5, maximum: 180 },
    openingTime: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", example: "10:00" },
    closingTime: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", example: "23:30" },
  },
};

const foodInput = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 2, maxLength: 100 },
    description: { type: "string", maxLength: 500 },
    category: { type: "string", description: "Active FoodCategory id" },
    pricePaise: { type: "integer", minimum: 100, description: "Price in integer paise" },
    isVeg: { type: "boolean" },
    isAvailable: { type: "boolean" },
    imageUrl: { type: "string", format: "uri" },
    prepTimeMinutes: { type: "integer", minimum: 1, maximum: 180 },
    tags: { type: "array", maxItems: 10, items: { type: "string" } },
  },
};

const categoryInput = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 2, maxLength: 50 },
    description: { type: "string", maxLength: 300 },
    icon: { type: "string", description: "Material Symbols icon name", example: "local_pizza" },
    imageUrl: { type: "string", format: "uri" },
    sortOrder: { type: "integer", minimum: 0 },
    isActive: { type: "boolean" },
  },
};

const placeSchema = { type: "object", properties: { label: { type: "string", example: "Topsia, Kolkata" }, displayName: { type: "string" }, latitude: { type: "number" }, longitude: { type: "number" }, area: { type: ["string", "null"] }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] }, postalCode: { type: ["string", "null"] } } };

export const catalogSchemas = {
  Address: {
    type: "object",
    required: ["line1", "city", "state", "postalCode"],
    properties: {
      line1: { type: "string" },
      line2: { type: "string" },
      area: { type: "string" },
      city: { type: "string" },
      state: { type: "string" },
      postalCode: { type: "string" },
    },
  },
  Restaurant: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      slug: { type: "string" },
      description: { type: "string" },
      cuisines: { type: "array", items: { type: "string" } },
      phone: { type: "string" },
      address: ref("Address"),
      location: {
        type: "object",
        properties: { type: { const: "Point" }, coordinates: { type: "array", items: { type: "number" }, description: "[longitude, latitude]" } },
      },
      imageUrl: { type: "string" },
      isPureVeg: { type: "boolean" },
      costForTwoPaise: { type: "integer" },
      minOrderPaise: { type: "integer" },
      avgPrepTimeMinutes: { type: "integer" },
      openingTime: { type: "string" },
      closingTime: { type: "string" },
      isAcceptingOrders: { type: "boolean" },
      isOpenNow: { type: "boolean", description: "Within opening hours (restaurant timezone) and accepting orders" },
      status: { type: "string", enum: ["pending", "approved", "rejected", "suspended"] },
      statusReason: { type: "string", description: "Owner/admin views only" },
      rating: { type: "object", properties: { average: { type: "number" }, count: { type: "integer" } } },
      distanceMeters: { type: "integer", description: "Straight-line distance; only when lat/lng were sent. Not road distance." },
    },
  },
  FoodCategory: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      slug: { type: "string" },
      description: { type: "string" },
      icon: { type: "string" },
      imageUrl: { type: "string" },
      sortOrder: { type: "integer" },
      isActive: { type: "boolean" },
      itemCount: { type: "integer", description: "Admin list only" },
    },
  },
  FoodItem: {
    type: "object",
    properties: {
      id: { type: "string" },
      restaurant: { description: "Restaurant id, or a restaurant summary in search results" },
      category: ref("FoodCategory"),
      name: { type: "string" },
      description: { type: "string" },
      pricePaise: { type: "integer" },
      isVeg: { type: "boolean" },
      isAvailable: { type: "boolean" },
      imageUrl: { type: "string" },
      prepTimeMinutes: { type: "integer" },
      tags: { type: "array", items: { type: "string" } },
    },
  },
};

export const catalogTags = [{ name: "Catalogue (public)" }, { name: "My restaurant" }, { name: "Admin - Catalogue" }, { name: "Uploads" }, { name: "Location" }];

const T = { pub: ["Catalogue (public)"], mine: ["My restaurant"], admin: ["Admin - Catalogue"] };
const restaurantData = { type: "object", properties: { restaurant: ref("Restaurant") } };
const itemData = { type: "object", properties: { item: ref("FoodItem") } };
const categoryData = { type: "object", properties: { category: ref("FoodCategory") } };
const slugOrId = { in: "path", name: "slugOrId", required: true, schema: { type: "string" } };

export const catalogPaths = {
  "/restaurants": {
    get: {
      tags: T.pub,
      summary: "List approved restaurants",
      parameters: [
        ...paging,
        q("search", { type: "string" }, "Matches restaurant name, cuisine, or a dish name"),
        q("cuisine", { type: "string" }),
        q("category", { type: "string" }, "FoodCategory id; restaurants with available items in it"),
        q("veg", { type: "boolean" }, "Pure-veg restaurants only"),
        q("sort", { type: "string", enum: ["rating", "fastest", "costLow", "costHigh", "newest", "distance"] }),
        q("lat", { type: "number" }, "With lng: nearby search, adds distanceMeters, default sort distance"),
        q("lng", { type: "number" }),
        q("radiusKm", { type: "number", minimum: 1, maximum: 50, default: 15 }),
      ],
      responses: { 200: ok(paged(ref("Restaurant"))), 400: err("distance sort without coordinates"), 422: err("Validation failed") },
    },
  },
  "/restaurants/cuisines": {
    get: { tags: T.pub, summary: "Cuisines offered by approved restaurants", responses: { 200: ok({ type: "object", properties: { cuisines: { type: "array", items: { type: "string" } } } }) } },
  },
  "/restaurants/{slugOrId}": {
    get: { tags: T.pub, summary: "Approved restaurant details", parameters: [slugOrId], responses: { 200: ok(restaurantData), 404: err("Not found or not approved") } },
  },
  "/restaurants/{slugOrId}/menu": {
    get: {
      tags: T.pub,
      summary: "Menu grouped by category (unavailable items included, flagged)",
      parameters: [slugOrId],
      responses: {
        200: ok({
          type: "object",
          properties: {
            sections: {
              type: "array",
              items: { type: "object", properties: { category: ref("FoodCategory"), items: { type: "array", items: ref("FoodItem") } } },
            },
          },
        }),
        404: err("Not found"),
      },
    },
  },
  "/categories": {
    get: { tags: T.pub, summary: "Active food categories", responses: { 200: ok({ type: "object", properties: { categories: { type: "array", items: ref("FoodCategory") } } }) } },
  },
  "/foods": {
    get: {
      tags: T.pub,
      summary: "Search available dishes across approved restaurants",
      parameters: [...paging, q("search", { type: "string" }), q("category", { type: "string" }), q("veg", { type: "boolean" })],
      responses: { 200: ok(paged(ref("FoodItem"))) },
    },
  },
  "/foods/{id}": {
    get: { tags: T.pub, summary: "Dish details", parameters: [idParam], responses: { 200: ok(itemData), 404: err("Not found") } },
  },

  "/my/restaurant": {
    get: {
      tags: T.mine,
      summary: "My restaurant (null if not created) and menu stats",
      security: bearer,
      responses: {
        200: ok({
          type: "object",
          properties: {
            restaurant: { oneOf: [ref("Restaurant"), { type: "null" }] },
            stats: { type: "object", properties: { totalItems: { type: "integer" }, availableItems: { type: "integer" }, categoriesUsed: { type: "integer" } } },
          },
        }),
        403: err("Not a restaurant partner"),
      },
    },
    post: {
      tags: T.mine,
      summary: "Create my restaurant (status pending until approved)",
      security: bearer,
      requestBody: body({ ...restaurantInput, required: ["name", "cuisines", "phone", "address", "location", "costForTwoPaise", "openingTime", "closingTime"] }),
      responses: { 201: ok(restaurantData), 409: err("Already have a restaurant"), 422: err("Validation failed") },
    },
    patch: {
      tags: T.mine,
      summary: "Update my restaurant (a rejected restaurant is re-submitted as pending)",
      security: bearer,
      requestBody: body(restaurantInput),
      responses: { 200: ok(restaurantData), 404: err("No restaurant yet"), 422: err("Validation failed") },
    },
  },
  "/my/restaurant/accepting-orders": {
    patch: {
      tags: T.mine,
      summary: "Pause or resume orders",
      security: bearer,
      requestBody: body({ type: "object", required: ["isAcceptingOrders"], properties: { isAcceptingOrders: { type: "boolean" } } }),
      responses: { 200: ok(restaurantData) },
    },
  },
  "/my/restaurant/foods": {
    get: {
      tags: T.mine,
      summary: "My menu items",
      security: bearer,
      parameters: [...paging, q("search", { type: "string" }), q("category", { type: "string" }), q("available", { type: "boolean" }), q("veg", { type: "boolean" })],
      responses: { 200: ok(paged(ref("FoodItem"))), 404: err("No restaurant yet") },
    },
    post: {
      tags: T.mine,
      summary: "Add a menu item",
      security: bearer,
      requestBody: body({ ...foodInput, required: ["name", "category", "pricePaise", "isVeg"] }),
      responses: { 201: ok(itemData), 409: err("Duplicate name on this menu"), 422: err("Validation failed / inactive category") },
    },
  },
  "/my/restaurant/foods/{id}": {
    patch: { tags: T.mine, summary: "Edit a menu item", security: bearer, parameters: [idParam], requestBody: body(foodInput), responses: { 200: ok(itemData), 404: err("Not found on my menu") } },
    delete: { tags: T.mine, summary: "Delete a menu item (soft delete)", security: bearer, parameters: [idParam], responses: { 200: ok({ type: "null" }), 404: err("Not found on my menu") } },
  },
  "/my/restaurant/foods/{id}/availability": {
    patch: {
      tags: T.mine,
      summary: "Mark a menu item available/unavailable",
      security: bearer,
      parameters: [idParam],
      requestBody: body({ type: "object", required: ["isAvailable"], properties: { isAvailable: { type: "boolean" } } }),
      responses: { 200: ok(itemData), 404: err("Not found on my menu") },
    },
  },

  "/admin/restaurants": {
    get: {
      tags: T.admin,
      summary: "List restaurants (any status)",
      security: bearer,
      parameters: [...paging, q("search", { type: "string" }), q("status", { type: "string", enum: ["pending", "approved", "rejected", "suspended"] })],
      responses: { 200: ok(paged(ref("Restaurant"))), 403: err("Not an admin") },
    },
  },
  "/admin/restaurants/counts": {
    get: { tags: T.admin, summary: "Restaurant counts by status", security: bearer, responses: { 200: ok({ type: "object", properties: { counts: { type: "object", additionalProperties: { type: "integer" } } } }) } },
  },
  "/admin/restaurants/{id}": {
    get: { tags: T.admin, summary: "Restaurant details with owner and menu stats", security: bearer, parameters: [idParam], responses: { 200: ok(restaurantData), 404: err("Not found") } },
  },
  "/admin/restaurants/{id}/status": {
    patch: {
      tags: T.admin,
      summary: "Approve, reject, suspend or reinstate",
      description: "Allowed: pending→approved|rejected, approved→suspended, suspended→approved, rejected→approved. A reason is required to reject or suspend.",
      security: bearer,
      parameters: [idParam],
      requestBody: body({
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", enum: ["approved", "rejected", "suspended"] }, reason: { type: "string", maxLength: 500 } },
      }),
      responses: { 200: ok(restaurantData), 400: err("Reason required"), 409: err("Transition not allowed or concurrent update") },
    },
  },
  "/admin/categories": {
    get: { tags: T.admin, summary: "All categories with item counts", security: bearer, responses: { 200: ok({ type: "object", properties: { categories: { type: "array", items: ref("FoodCategory") } } }) } },
    post: { tags: T.admin, summary: "Create a category", security: bearer, requestBody: body({ ...categoryInput, required: ["name"] }), responses: { 201: ok(categoryData), 409: err("Name exists") } },
  },
  "/admin/categories/{id}": {
    patch: { tags: T.admin, summary: "Update a category", security: bearer, parameters: [idParam], requestBody: body(categoryInput), responses: { 200: ok(categoryData), 409: err("Name exists") } },
    delete: { tags: T.admin, summary: "Delete an unused category", security: bearer, parameters: [idParam], responses: { 200: ok({ type: "null" }), 409: err("Category in use; deactivate instead") } },
  },
  "/admin/foods": {
    get: {
      tags: T.admin,
      summary: "All menu items",
      security: bearer,
      parameters: [...paging, q("search", { type: "string" }), q("restaurant", { type: "string" }), q("category", { type: "string" }), q("available", { type: "boolean" }), q("veg", { type: "boolean" })],
      responses: { 200: ok(paged(ref("FoodItem"))) },
    },
  },
  "/admin/foods/{id}/availability": {
    patch: {
      tags: T.admin,
      summary: "Set availability of any menu item",
      security: bearer,
      parameters: [idParam],
      requestBody: body({ type: "object", required: ["isAvailable"], properties: { isAvailable: { type: "boolean" } } }),
      responses: { 200: ok(itemData), 404: err("Not found") },
    },
  },
  "/admin/foods/{id}": {
    delete: { tags: T.admin, summary: "Delete any menu item (soft delete)", security: bearer, parameters: [idParam], responses: { 200: ok({ type: "null" }), 404: err("Not found") } },
  },
  "/geo/search": {
    get: {
      tags: ["Location"],
      summary: "Search places by name (OpenStreetMap Nominatim, cached and throttled)",
      parameters: [q("q", { type: "string", minLength: 3, maxLength: 120 })],
      responses: { 200: ok({ type: "object", properties: { places: { type: "array", items: placeSchema } } }), 503: err("Geocoder unavailable") },
    },
  },
  "/geo/reverse": {
    get: {
      tags: ["Location"],
      summary: "Readable place name for coordinates",
      parameters: [q("lat", { type: "number" }), q("lng", { type: "number" })],
      responses: { 200: ok({ type: "object", properties: { place: placeSchema } }), 404: err("No address here"), 503: err("Geocoder unavailable") },
    },
  },
  "/geo/route": {
    get: {
      tags: ["Location"],
      summary: "Road route between two points (signed-in users)",
      description:
        "Estimated road distance and travel time plus the path to draw (OSRM by default; cached and throttled). " +
        "straightLineMeters is reported separately. These are estimates without live traffic, not the rider's actual progress. " +
        "503 ROUTING_UNAVAILABLE means the client should draw a straight line instead.",
      security: [{ bearerAuth: [] }],
      parameters: [q("fromLat", { type: "number" }), q("fromLng", { type: "number" }), q("toLat", { type: "number" }), q("toLng", { type: "number" })],
      responses: {
        200: ok({
          type: "object",
          properties: {
            route: {
              type: "object",
              properties: {
                distanceMeters: { type: "integer" },
                durationSeconds: { type: "integer" },
                straightLineMeters: { type: "integer" },
                path: { type: "array", items: { type: "object", properties: { latitude: { type: "number" }, longitude: { type: "number" } } } },
                provider: { type: "string" },
                attribution: { type: "string" },
                estimate: { const: true },
              },
            },
          },
        }),
        400: err("Points more than 100 km apart"),
        401: err("Not signed in"),
        503: err("Routing unavailable"),
      },
    },
  },
  "/uploads/images": {
    post: {
      tags: ["Uploads"],
      summary: "Upload an image (restaurant partners and admins)",
      description: "JPEG, PNG or WebP, max 2 MB. The type is detected from the file bytes. Returns a public URL to use as imageUrl.",
      security: bearer,
      requestBody: {
        required: true,
        content: { "multipart/form-data": { schema: { type: "object", required: ["image"], properties: { image: { type: "string", format: "binary" } } } } },
      },
      responses: {
        201: ok({ type: "object", properties: { url: { type: "string" }, bytes: { type: "integer" }, type: { type: "string" } } }),
        403: err("Role not allowed"),
        413: err("Larger than 2 MB"),
        415: err("Not a JPEG/PNG/WebP image"),
      },
    },
  },
};
