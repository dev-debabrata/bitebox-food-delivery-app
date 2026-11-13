// Access-control matrix (same as backend-django/tests/test_access_control.py): every API route ×
// every method × every role. Each route's guards come from the route table (authenticate,
// authorize(...roles), can(...permissions)); a role they refuse must get 403, an anonymous caller
// 401, before the route runs. The routes anyone may call are listed in PUBLIC.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ALL_ROLES } from "../config/roles.js";
import { buildApp, createAndLogin, request, setupTestDb, teardownTestDb } from "./helpers.js";
import { allows, appWithRoutes, routeTable } from "./route-table.js";

// Anyone may call these (keep in step with backend-django/tests/test_access_control.py PUBLIC).
const PUBLIC = [
  "get /api/v1/categories",
  "get /api/v1/foods",
  "get /api/v1/foods/{id}",
  "get /api/v1/foods/{id}/reviews",
  "get /api/v1/auth/methods",
  "get /api/v1/geo/reverse",
  "get /api/v1/geo/search",
  "get /api/v1/health",
  "get /api/v1/health/live",
  "get /api/v1/health/ready",
  "get /api/v1/payments/methods",
  "get /api/v1/push/public-key",
  "get /api/v1/restaurants",
  "get /api/v1/restaurants/cuisines",
  "get /api/v1/restaurants/{slugOrId}",
  "get /api/v1/restaurants/{slugOrId}/menu",
  "get /api/v1/restaurants/{slugOrId}/reviews",
  "post /api/v1/auth/forgot-password",
  "post /api/v1/auth/login",
  "post /api/v1/auth/otp/login",
  "post /api/v1/auth/otp/request",
  "post /api/v1/auth/email/verify",
  "post /api/v1/auth/logout",
  "post /api/v1/auth/refresh",
  "post /api/v1/auth/register",
  "post /api/v1/auth/register/code",
  "post /api/v1/auth/reset-password",
  "post /api/v1/newsletter/subscriptions",
  "post /api/v1/payments/webhooks/razorpay",
  "post /api/v1/referrals/validate",
];

const app = await appWithRoutes(() => buildApp());
const routes = routeTable(app);
const key = (r) => `${r.method} ${r.path}`;


describe("access-control matrix", () => {
  before(setupTestDb);
  after(teardownTestDb);

  it("lists exactly the public routes", () => {
    const open = routes.filter((r) => allows(r, undefined)).map(key).sort();
    assert.deepEqual(open, [...PUBLIC].sort());
  });

  it("answers 401 to anonymous callers everywhere else", async () => {
    const wrong = [];
    for (const r of routes.filter((r) => !allows(r, undefined))) {
      const res = await request(app)[r.method](r.url).send({});
      if (res.status !== 401) wrong.push(`${key(r)} -> ${res.status}`);
    }
    assert.deepEqual(wrong, []);
  });

  it("answers 403 to every role on routes it has no access to", async () => {
    const wrong = [];
    let checked = 0;
    for (const role of ALL_ROLES) {
      const { token } = await createAndLogin(app, role);
      for (const r of routes.filter((r) => !allows(r, role))) {
        checked++;
        const res = await request(app)[r.method](r.url).set("Authorization", `Bearer ${token}`).send({});
        if (res.status !== 403) wrong.push(`${role} ${key(r)} -> ${res.status}`);
      }
    }
    assert.deepEqual(wrong, []);
    assert.ok(checked > 500, `only ${checked} checks`);
  });
});
