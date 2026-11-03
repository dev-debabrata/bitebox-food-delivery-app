import { catalogPaths, catalogSchemas, catalogTags } from "./openapi.catalog.js";
import { checkoutPaths, checkoutSchemas, checkoutTags } from "./openapi.checkout.js";
import { ordersPaths, ordersSchemas, ordersTags } from "./openapi.orders.js";
import { paymentsPaths, paymentsSchemas, paymentsTags } from "./openapi.payments.js";

/**
 * OpenAPI 3.1 contract for the implemented API. Keep this in sync with
 * src/routes and src/validators when endpoints change.
 */
const ok = (dataSchema, description = "Success") => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["success", "message", "data"],
        properties: { success: { const: true }, message: { type: "string" }, data: dataSchema },
      },
    },
  },
});

const err = (description) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });

const jsonBody = (schemaRef) => ({ required: true, content: { "application/json": { schema: { $ref: schemaRef } } } });

const sessionData = {
  type: "object",
  properties: { user: { $ref: "#/components/schemas/User" }, accessToken: { type: "string" } },
};

const password = { type: "string", minLength: 8, description: "8+ chars (max 72 bytes), at least one letter and one number" };

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "BiteBox API",
    version: "1.0.0",
    description:
      "BiteBox food delivery REST API. Authenticate with `POST /auth/login`, then send the returned access token as `Authorization: Bearer <token>`. The refresh token is set as an HttpOnly cookie scoped to `/api/v1/auth`. Every response uses the envelope `{ success, message, data }`; errors add `error.code` and, for validation, `error.details[{ field, message }]`. Money is always in integer paise. Live updates are pushed over Socket.IO (`order:updated`, `notification:new`, `order:location`).",
  },
  servers: [{ url: "/api/v1" }],
  tags: [{ name: "Health" }, { name: "Auth" }, { name: "Admin - Users" }, ...catalogTags, ...checkoutTags, ...ordersTags, ...paymentsTags],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    schemas: {
      ...catalogSchemas,
      ...checkoutSchemas,
      ...ordersSchemas,
      ...paymentsSchemas,
      Role: { type: "string", enum: ["customer", "admin", "restaurant", "delivery"] },
      User: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string", format: "email" },
          phone: { type: "string" },
          role: { $ref: "#/components/schemas/Role" },
          status: { type: "string", enum: ["active", "suspended"] },
          lastLoginAt: { type: "string", format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      Error: {
        type: "object",
        properties: {
          success: { const: false },
          message: { type: "string" },
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              details: {
                type: "array",
                items: { type: "object", properties: { field: { type: "string" }, message: { type: "string" } } },
              },
            },
          },
        },
      },
      RegisterRequest: {
        type: "object",
        required: ["name", "email", "password"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 80 },
          email: { type: "string", format: "email" },
          phone: { type: "string", pattern: "^\\+?[0-9]{10,15}$" },
          password,
          role: { type: "string", enum: ["customer", "restaurant", "delivery"], default: "customer" },
        },
      },
      LoginRequest: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string" },
          portal: { $ref: "#/components/schemas/Role", description: "When set, sign-in fails unless the account has this role" },
        },
      },
      ForgotPasswordRequest: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } },
      ResetPasswordRequest: {
        type: "object",
        required: ["token", "password"],
        properties: { token: { type: "string" }, password },
      },
      ChangePasswordRequest: {
        type: "object",
        required: ["currentPassword", "newPassword"],
        properties: { currentPassword: { type: "string" }, newPassword: password },
      },
      UpdateProfileRequest: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 2, maxLength: 80 },
          phone: { type: "string", description: "Empty string removes the phone number" },
        },
      },
      Pagination: {
        type: "object",
        properties: { page: { type: "integer" }, limit: { type: "integer" }, total: { type: "integer" }, totalPages: { type: "integer" } },
      },
    },
  },
  paths: {
    ...catalogPaths,
    ...checkoutPaths,
    ...ordersPaths,
    ...paymentsPaths,
    "/health": {
      get: {
        tags: ["Health"],
        summary: "API and database health",
        responses: {
          200: ok({ type: "object", properties: { status: { type: "string" }, database: { type: "string" } } }),
          503: { description: "Database unreachable" },
        },
      },
    },
    "/auth/register": {
      post: {
        tags: ["Auth"],
        summary: "Register a customer, restaurant or delivery partner account",
        requestBody: jsonBody("#/components/schemas/RegisterRequest"),
        responses: { 201: ok(sessionData, "Account created; refresh cookie set"), 409: err("Email or phone in use"), 422: err("Validation failed"), 429: err("Rate limited") },
      },
    },
    "/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Sign in",
        requestBody: jsonBody("#/components/schemas/LoginRequest"),
        responses: { 200: ok(sessionData, "Signed in; refresh cookie set"), 401: err("Invalid credentials"), 403: err("Suspended or wrong portal"), 429: err("Rate limited") },
      },
    },
    "/auth/refresh": {
      post: {
        tags: ["Auth"],
        summary: "Rotate the refresh cookie and get a new access token",
        description: "Requires the `bb_refresh` cookie and header `X-Requested-With: BiteBox`.",
        parameters: [{ in: "header", name: "X-Requested-With", required: true, schema: { const: "BiteBox" } }],
        responses: { 200: ok(sessionData), 401: err("No/expired session"), 403: err("Untrusted origin or missing CSRF header") },
      },
    },
    "/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Revoke the current refresh session",
        parameters: [{ in: "header", name: "X-Requested-With", required: true, schema: { const: "BiteBox" } }],
        responses: { 200: ok({ type: "null" }) },
      },
    },
    "/auth/forgot-password": {
      post: {
        tags: ["Auth"],
        summary: "Email a single-use password reset link",
        description: "Always returns 200 so the response does not reveal whether the email is registered.",
        requestBody: jsonBody("#/components/schemas/ForgotPasswordRequest"),
        responses: { 200: ok({ type: "null" }), 422: err("Validation failed"), 429: err("Rate limited") },
      },
    },
    "/auth/reset-password": {
      post: {
        tags: ["Auth"],
        summary: "Reset password with a token from the email link",
        requestBody: jsonBody("#/components/schemas/ResetPasswordRequest"),
        responses: { 200: ok({ type: "null" }), 400: err("Invalid or expired token"), 422: err("Validation failed") },
      },
    },
    "/auth/me": {
      get: {
        tags: ["Auth"],
        summary: "Current user",
        security: [{ bearerAuth: [] }],
        responses: { 200: ok({ type: "object", properties: { user: { $ref: "#/components/schemas/User" } } }), 401: err("Unauthenticated") },
      },
      patch: {
        tags: ["Auth"],
        summary: "Update own profile",
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody("#/components/schemas/UpdateProfileRequest"),
        responses: { 200: ok({ type: "object", properties: { user: { $ref: "#/components/schemas/User" } } }), 409: err("Phone in use"), 422: err("Validation failed") },
      },
    },
    "/auth/change-password": {
      post: {
        tags: ["Auth"],
        summary: "Change password (signs out all sessions)",
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody("#/components/schemas/ChangePasswordRequest"),
        responses: { 200: ok({ type: "null" }), 400: err("Current password incorrect"), 422: err("Validation failed") },
      },
    },
    "/admin/users": {
      get: {
        tags: ["Admin - Users"],
        summary: "List users (admin only)",
        security: [{ bearerAuth: [] }],
        parameters: [
          { in: "query", name: "role", schema: { $ref: "#/components/schemas/Role" } },
          { in: "query", name: "status", schema: { type: "string", enum: ["active", "suspended"] } },
          { in: "query", name: "search", schema: { type: "string", maxLength: 100 } },
          { in: "query", name: "page", schema: { type: "integer", minimum: 1 } },
          { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
        ],
        responses: {
          200: ok({
            type: "object",
            properties: { items: { type: "array", items: { $ref: "#/components/schemas/User" } }, pagination: { $ref: "#/components/schemas/Pagination" } },
          }),
          401: err("Unauthenticated"),
          403: err("Not an admin"),
        },
      },
    },
  },
};
