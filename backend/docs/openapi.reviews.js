import { REPORT_REASONS, REVIEW_POLICY } from "../config/reviews.js";

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
const slugOrId = {
  in: "path",
  name: "slugOrId",
  required: true,
  schema: { type: "string" },
};
const paging = [
  { in: "query", name: "page", schema: { type: "integer", minimum: 1 } },
  {
    in: "query",
    name: "limit",
    schema: { type: "integer", minimum: 1, maximum: 100 },
  },
];
const ratingFilter = {
  in: "query",
  name: "rating",
  schema: { type: "integer", minimum: 1, maximum: 5 },
};
const sort = {
  in: "query",
  name: "sort",
  schema: {
    type: "string",
    enum: ["newest", "oldest", "highest", "lowest"],
    default: "newest",
  },
};
const target = (values = ["restaurant", "food", "rider"]) => ({
  in: "query",
  name: "target",
  schema: { type: "string", enum: values },
});
const pagination = ref("Pagination");
const reviewList = (item, extra = {}) =>
  ok({
    type: "object",
    properties: {
      ...extra,
      items: { type: "array", items: ref(item) },
      pagination,
    },
  });
const one = (schema = "MyReview") =>
  ok({ type: "object", properties: { review: ref(schema) } });

export const reviewsTags = [
  {
    name: "Reviews",
    description: `Customers rate the restaurant, each dish and the rider of a delivered order, once each, within ${REVIEW_POLICY.submitWindowDays} days of delivery. Reviews can be edited for ${REVIEW_POLICY.editWindowDays} days; deleting one is final. Averages count published reviews only.`,
  },
  { name: "Reviews - Restaurant & rider" },
  { name: "Admin - Reviews" },
];

export const reviewsSchemas = {
  RatingSummary: {
    type: "object",
    properties: {
      average: { type: "number", minimum: 0, maximum: 5 },
      count: { type: "integer" },
      distribution: {
        type: "array",
        items: { type: "integer" },
        minItems: 5,
        maxItems: 5,
        description: "distribution[i] = number of (i + 1)-star reviews",
      },
    },
  },
  ReviewResponse: {
    type: ["object", "null"],
    properties: {
      text: { type: "string" },
      respondedAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  PublicReview: {
    type: "object",
    description: "No customer id, order or contact details",
    properties: {
      id: { type: "string" },
      target: { type: "string", enum: ["restaurant", "food", "rider"] },
      rating: { type: "integer", minimum: 1, maximum: 5 },
      comment: { type: "string" },
      authorName: { type: "string", example: "Asha Customer" },
      foodItem: { type: ["string", "null"] },
      foodName: { type: ["string", "null"] },
      images: {
        type: "array",
        items: { type: "string", format: "uri" },
        maxItems: REVIEW_POLICY.maxImages,
      },
      verifiedOrder: { const: true },
      response: ref("ReviewResponse"),
      createdAt: { type: "string", format: "date-time" },
      editedAt: { type: ["string", "null"], format: "date-time" },
    },
  },
  MyReview: {
    allOf: [
      ref("PublicReview"),
      {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["published", "hidden", "removed"],
          },
          order: { type: "string" },
          orderNumber: { type: "string" },
          restaurant: { type: "string" },
          moderation: {
            type: ["object", "null"],
            properties: {
              action: { type: "string" },
              reason: { type: "string" },
            },
          },
          editableUntil: { type: ["string", "null"], format: "date-time" },
        },
      },
    ],
  },
  CreateReviewRequest: {
    type: "object",
    required: ["orderId", "target", "rating"],
    properties: {
      orderId: { type: "string" },
      target: { type: "string", enum: ["restaurant", "food", "rider"] },
      foodItemId: {
        type: "string",
        description: "Required when target is food; must be a line of the order",
      },
      rating: { type: "integer", minimum: 1, maximum: 5 },
      comment: { type: "string", maxLength: REVIEW_POLICY.commentMaxLength },
      images: {
        type: "array",
        maxItems: REVIEW_POLICY.maxImages,
        items: { type: "string" },
        description:
          "URLs from POST /uploads/review-images (restaurant and dish reviews only)",
      },
    },
  },
  AdminReview: {
    type: "object",
    description:
      "The full record. Admins change visibility only; the words are never edited.",
    properties: {
      id: { type: "string" },
      target: { type: "string" },
      status: {
        type: "string",
        enum: ["published", "hidden", "removed", "deleted"],
      },
      rating: { type: "integer" },
      comment: { type: "string" },
      customerName: { type: "string" },
      orderNumber: { type: "string" },
      openReports: { type: "integer" },
      edits: {
        type: "array",
        description: "Earlier versions the customer replaced",
        items: { type: "object" },
      },
      moderationLog: {
        type: "array",
        items: {
          type: "object",
          properties: {
            action: { type: "string" },
            reason: { type: "string" },
            fromStatus: { type: "string" },
            toStatus: { type: "string" },
            at: { type: "string", format: "date-time" },
            by: { type: "object" },
          },
        },
      },
      reports: { type: "array", items: { type: "object" } },
    },
  },
};

export const reviewsPaths = {
  "/restaurants/{slugOrId}/reviews": {
    get: {
      tags: ["Reviews"],
      summary: "Published reviews of a restaurant, with its rating summary",
      parameters: [slugOrId, ratingFilter, sort, ...paging],
      responses: {
        200: reviewList("PublicReview", { summary: ref("RatingSummary") }),
        404: err("Restaurant not found"),
      },
    },
  },
  "/foods/{id}/reviews": {
    get: {
      tags: ["Reviews"],
      summary: "Published reviews of a dish, with its rating summary",
      parameters: [idParam, ratingFilter, sort, ...paging],
      responses: {
        200: reviewList("PublicReview", { summary: ref("RatingSummary") }),
        404: err("Dish not found"),
      },
    },
  },
  "/orders/{id}/reviews": {
    get: {
      tags: ["Reviews"],
      summary:
        "What I can review on my order (restaurant, each dish, rider) and what I already did",
      security: bearer,
      parameters: [idParam],
      responses: { 200: ok({ type: "object" }), 404: err("Order not found") },
    },
    post: {
      tags: ["Reviews"],
      summary:
        "Rate the whole order at once: restaurant (with comment and photos), food quality (every dish not yet rated) and delivery",
      security: bearer,
      parameters: [idParam],
      requestBody: body({
        type: "object",
        properties: {
          restaurant: { type: "integer", minimum: 1, maximum: 5 },
          food: { type: "integer", minimum: 1, maximum: 5 },
          rider: { type: "integer", minimum: 1, maximum: 5 },
          comment: { type: "string", maxLength: REVIEW_POLICY.commentMaxLength },
          images: {
            type: "array",
            maxItems: REVIEW_POLICY.maxImages,
            items: { type: "string" },
          },
        },
      }),
      responses: {
        201: ok({ type: "object" }),
        409: err("DUPLICATE_REVIEW, ORDER_NOT_DELIVERED or REVIEW_WINDOW_CLOSED (nothing is saved)"),
        422: err("Validation failed"),
      },
    },
  },
  "/uploads/review-images": {
    post: {
      tags: ["Reviews"],
      summary: "Upload one review photo (customers; JPEG, PNG or WebP, 2 MB)",
      security: bearer,
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: { image: { type: "string", format: "binary" } },
            },
          },
        },
      },
      responses: {
        201: ok({ type: "object", properties: { url: { type: "string" } } }),
        413: err("Larger than 2 MB"),
        415: err("Not an image"),
      },
    },
  },
  "/reviews": {
    post: {
      tags: ["Reviews"],
      summary: "Review the restaurant, a dish or the rider of my delivered order",
      security: bearer,
      requestBody: body(ref("CreateReviewRequest")),
      responses: {
        201: one(),
        404: err("Order not found (or not mine)"),
        409: err(
          "DUPLICATE_REVIEW, ORDER_NOT_DELIVERED, REVIEW_WINDOW_CLOSED or NO_RIDER",
        ),
        422: err("Validation failed"),
      },
    },
  },
  "/reviews/mine": {
    get: {
      tags: ["Reviews"],
      summary: "My reviews, newest first (hidden and removed ones say why)",
      security: bearer,
      parameters: [target(), sort, ...paging],
      responses: { 200: reviewList("MyReview") },
    },
  },
  "/reviews/{id}": {
    get: {
      tags: ["Reviews"],
      summary: "One of my reviews",
      security: bearer,
      parameters: [idParam],
      responses: { 200: one(), 404: err("Not found") },
    },
    patch: {
      tags: ["Reviews"],
      summary: `Edit my review (within ${REVIEW_POLICY.editWindowDays} days; earlier versions are kept for moderators)`,
      security: bearer,
      parameters: [idParam],
      requestBody: body({
        type: "object",
        properties: {
          rating: { type: "integer", minimum: 1, maximum: 5 },
          comment: { type: "string" },
          images: { type: "array", items: { type: "string" } },
        },
      }),
      responses: {
        200: one(),
        409: err("REVIEW_LOCKED, EDIT_WINDOW_CLOSED or REVIEW_CHANGED"),
      },
    },
    delete: {
      tags: ["Reviews"],
      summary: "Delete my review (final: it cannot be written again for this order)",
      security: bearer,
      parameters: [idParam],
      responses: { 200: ok({ type: "object" }), 404: err("Not found") },
    },
  },
  "/reviews/{id}/reports": {
    post: {
      tags: ["Reviews"],
      summary:
        "Report a published review (customers: any but their own; restaurants: their own reviews; riders: reviews of them)",
      security: bearer,
      parameters: [idParam],
      requestBody: body({
        type: "object",
        required: ["reason"],
        properties: {
          reason: { type: "string", enum: REPORT_REASONS },
          note: { type: "string", maxLength: REVIEW_POLICY.reportNoteMaxLength },
        },
      }),
      responses: {
        201: ok({ type: "object" }),
        409: err("ALREADY_REPORTED"),
      },
    },
  },
  "/my/restaurant/reviews/orders": {
    get: {
      tags: ["Reviews - Restaurant & rider"],
      summary:
        "Reviews grouped by order: one row per order with its restaurant and dish reviews ",
      security: bearer,
      parameters: [
        target(["restaurant", "food"]),
        { in: "query", name: "foodItemId", schema: { type: "string" } },
        ratingFilter,
        { in: "query", name: "responded", schema: { type: "boolean" } },
        sort,
        ...paging,
      ],
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/my/restaurant/reviews/orders/{orderId}": {
    get: {
      tags: ["Reviews - Restaurant & rider"],
      summary: "Every review of one order (restaurant and dishes)",
      security: bearer,
      parameters: [{ in: "path", name: "orderId", required: true, schema: { type: "string" } }],
      responses: { 200: ok({ type: "object" }), 404: err("No reviews for this order") },
    },
  },
  "/my/restaurant/reviews/summary": {
    get: {
      tags: ["Reviews - Restaurant & rider"],
      summary: "My restaurant's rating, every dish's rating and the unanswered count",
      security: bearer,
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/my/restaurant/reviews/{id}/response": {
    put: {
      tags: ["Reviews - Restaurant & rider"],
      summary: "Post or edit a public reply (the review itself is untouched)",
      security: bearer,
      parameters: [idParam],
      requestBody: body({
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", maxLength: REVIEW_POLICY.responseMaxLength },
        },
      }),
      responses: { 200: one("PublicReview"), 404: err("Not my review") },
    },
    delete: {
      tags: ["Reviews - Restaurant & rider"],
      summary: "Remove my reply",
      security: bearer,
      parameters: [idParam],
      responses: { 200: one("PublicReview"), 404: err("Not my review") },
    },
  },
  "/delivery/reviews": {
    get: {
      tags: ["Reviews - Restaurant & rider"],
      summary:
        "Ratings of my deliveries (first name and order number only) with my summary",
      security: bearer,
      parameters: [ratingFilter, sort, ...paging],
      responses: {
        200: reviewList("PublicReview", { summary: ref("RatingSummary") }),
      },
    },
  },
  "/admin/reviews/orders": {
    get: {
      tags: ["Admin - Reviews"],
      summary:
        "Reviews grouped by order (`reported=true` puts orders with open reports first)",
      security: bearer,
      parameters: [
        target(),
        { in: "query", name: "status", schema: { type: "string" } },
        { in: "query", name: "reported", schema: { type: "boolean" } },
        { in: "query", name: "restaurantId", schema: { type: "string" } },
        ratingFilter,
        { in: "query", name: "search", schema: { type: "string" } },
        ...paging,
      ],
      responses: { 200: ok({ type: "object" }), 403: err("Not an admin") },
    },
  },
  "/admin/reviews/orders/{orderId}": {
    get: {
      tags: ["Admin - Reviews"],
      summary:
        "Every review of one order with earlier versions, reports and moderation logs",
      security: bearer,
      parameters: [{ in: "path", name: "orderId", required: true, schema: { type: "string" } }],
      responses: { 200: ok({ type: "object" }), 404: err("No reviews for this order") },
    },
  },
  "/admin/reviews/analytics": {
    get: {
      tags: ["Admin - Reviews"],
      summary:
        "Rating analytics: per-target averages and distributions, daily trend, reports, moderation, best and worst rated",
      security: bearer,
      parameters: [
        {
          in: "query",
          name: "days",
          schema: { type: "integer", minimum: 1, maximum: 365, default: 30 },
        },
      ],
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/admin/reviews/{id}": {
    get: {
      tags: ["Admin - Reviews"],
      summary: "One review with earlier versions, reports and the moderation log",
      security: bearer,
      parameters: [idParam],
      responses: { 200: one("AdminReview"), 404: err("Not found") },
    },
  },
  "/admin/reviews/{id}/moderation": {
    post: {
      tags: ["Admin - Reviews"],
      summary:
        "Hide, remove or restore a review. The reason is logged and shown to the author.",
      security: bearer,
      parameters: [idParam],
      requestBody: body({
        type: "object",
        required: ["action", "reason"],
        properties: {
          action: { type: "string", enum: ["hide", "remove", "restore"] },
          reason: { type: "string", minLength: 3, maxLength: 300 },
        },
      }),
      responses: {
        200: one("AdminReview"),
        409: err("INVALID_MODERATION or REVIEW_CHANGED"),
      },
    },
  },
  "/admin/reviews/{id}/reports/dismiss": {
    post: {
      tags: ["Admin - Reviews"],
      summary: "Close the open reports without acting on the review (logged)",
      security: bearer,
      parameters: [idParam],
      requestBody: body({
        type: "object",
        required: ["reason"],
        properties: { reason: { type: "string" } },
      }),
      responses: { 200: one("AdminReview"), 409: err("NO_OPEN_REPORTS") },
    },
  },
};
