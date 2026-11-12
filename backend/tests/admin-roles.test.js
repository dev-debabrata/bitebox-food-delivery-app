import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Address } from "../models/address.model.js";
import { AuditLog } from "../models/audit-log.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { Notification } from "../models/notification.model.js";
import { Order } from "../models/order.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import {
  buildApp,
  createAndLogin,
  request,
  resetDb,
  seedCatalogFor,
  setupTestDb,
  teardownTestDb,
  PASSWORD,
  riderStatusBody,
} from "./helpers.js";

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const NEAR = { latitude: 12.9729, longitude: 77.6412 };

describe("operations, finance and support admin roles", () => {
  let app;
  let as; // tokens by role

  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(teardownTestDb);

  beforeEach(async () => {
    await resetDb();
    as = {};
    for (const role of [
      "admin",
      "operations_admin",
      "finance_admin",
      "support_admin",
      "customer",
    ])
      as[role] = await createAndLogin(app, role);
  });

  const get = (path, who) => request(app).get(`/api/v1${path}`).set(auth(as[who].token));

  describe("permissions", () => {
    // [endpoint, roles allowed]; everyone else must get 403 (or 401 for nobody).
    const MATRIX = [
      ["/admin/admins", ["admin"]],
      ["/admin/audit-logs", ["admin"]],
      ["/admin/users", ["admin"]],
      ["/admin/categories", ["admin"]],
      ["/admin/coupons", ["admin"]],
      ["/admin/orders", ["admin", "operations_admin", "support_admin"]],
      ["/admin/restaurants", ["admin", "operations_admin"]],
      ["/admin/delivery-partners", ["admin", "operations_admin"]],
      ["/admin/operations/dashboard", ["admin", "operations_admin"]],
      ["/admin/operations/monitoring", ["admin", "operations_admin"]],
      ["/admin/payments", ["admin", "finance_admin"]],
      ["/admin/reports", ["admin", "finance_admin"]],
      ["/admin/finance/dashboard", ["admin", "finance_admin"]],
      ["/admin/finance/payouts?type=restaurant", ["admin", "finance_admin"]],
      ["/admin/support/dashboard", ["admin", "support_admin"]],
      ["/admin/support/tickets", ["admin", "support_admin"]],
      ["/admin/reviews/orders", ["admin", "support_admin"]],
    ];
    const ROLES = ["admin", "operations_admin", "finance_admin", "support_admin", "customer"];

    for (const [path, allowed] of MATRIX) {
      it(`${path} is open to ${allowed.join(", ")} only`, async () => {
        for (const role of ROLES) {
          const res = await get(path, role);
          const expected = allowed.includes(role) ? 200 : 403;
          assert.equal(res.status, expected, `${role} on ${path}: ${res.body.message}`);
        }
      });
    }

    it("lists only customers, restaurants and riders under Users", async () => {
      const res = await get("/admin/users?limit=100", "admin");
      const roles = new Set(res.body.data.items.map((u) => u.role));
      for (const admin of ["admin", "operations_admin", "finance_admin", "support_admin"])
        assert.ok(!roles.has(admin), `${admin} hidden`);
      assert.equal((await get("/admin/users?role=finance_admin", "admin")).status, 422);
      const suspend = await request(app)
        .patch(`/api/v1/admin/users/${as.finance_admin.user.id}/status`)
        .set(auth(as.admin.token))
        .send({ status: "suspended" });
      assert.equal(suspend.status, 400, "admins are managed in Admin management");
    });

    it("sends each admin role its permissions with the user", async () => {
      assert.ok(as.admin.user.permissions.includes("admins:manage"));
      assert.deepEqual(
        as.finance_admin.user.permissions.sort(),
        ["finance:view", "payouts:manage", "refunds:manage"],
      );
      assert.equal(as.customer.user.permissions, undefined);
    });

    it("lets operations cancel orders but not support", async () => {
      const missing = "/api/v1/admin/orders/000000000000000000000000/cancel";
      const support = await request(app)
        .post(missing)
        .set(auth(as.support_admin.token))
        .send({ reason: "Testing access" });
      assert.equal(support.status, 403);
      const ops = await request(app)
        .post(missing)
        .set(auth(as.operations_admin.token))
        .send({ reason: "Testing access" });
      assert.equal(ops.status, 404, "allowed through, order not found");
    });
  });

  describe("admin management", () => {
    const create = (body, token = as.admin.token) =>
      request(app).post("/api/v1/admin/admins").set(auth(token)).send(body);
    const NEW = {
      name: "Nora Ops",
      email: "nora.ops@example.com",
      password: "Ops-pass-123",
      role: "operations_admin",
    };

    it("creates a staff admin who can sign in with the right permissions", async () => {
      const res = await create(NEW);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.user.role, "operations_admin");
      const login = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: NEW.email, password: NEW.password });
      assert.equal(login.status, 200);
      assert.ok(login.body.data.user.permissions.includes("orders:manage"));

      const log = await AuditLog.findOne({ action: "admin.create" });
      assert.equal(String(log.admin), as.admin.user.id);
      assert.equal(log.adminRole, "admin");
      assert.equal(log.resourceId, res.body.data.user.id);
    });

    it("never creates another super admin or customer through this endpoint", async () => {
      for (const role of ["admin", "customer"])
        assert.equal((await create({ ...NEW, role })).status, 422);
    });

    it("forbids staff admins from managing admins", async () => {
      assert.equal((await create(NEW, as.operations_admin.token)).status, 403);
    });

    it("signs an admin out when their role changes", async () => {
      const created = (await create(NEW)).body.data.user;
      const login = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: NEW.email, password: NEW.password });
      const token = login.body.data.accessToken;

      const res = await request(app)
        .patch(`/api/v1/admin/admins/${created.id}`)
        .set(auth(as.admin.token))
        .send({ role: "finance_admin" });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.user.role, "finance_admin");
      const after = await request(app).get("/api/v1/auth/me").set(auth(token));
      assert.equal(after.status, 401, "old session no longer valid");
    });

    it("deactivates an admin and cannot change the super admin's own role", async () => {
      const created = (await create(NEW)).body.data.user;
      const off = await request(app)
        .patch(`/api/v1/admin/admins/${created.id}/status`)
        .set(auth(as.admin.token))
        .send({ status: "suspended" });
      assert.equal(off.status, 200);
      const login = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: NEW.email, password: NEW.password });
      assert.equal(login.status, 403);

      const self = await request(app)
        .patch(`/api/v1/admin/admins/${as.admin.user.id}`)
        .set(auth(as.admin.token))
        .send({ role: "support_admin" });
      assert.equal(self.status, 400);
    });

    it("keeps the role out of a user's own profile update", async () => {
      const res = await request(app)
        .patch("/api/v1/auth/me")
        .set(auth(as.support_admin.token))
        .send({ name: "Sana S", role: "admin" });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.user.role, "support_admin");
    });
  });

  describe("orders through to payouts", () => {
    let owner;
    let rider;

    beforeEach(async () => {
      owner = await seedCatalogFor(app);
      const { seedCheckoutData, seedDeliveryData } = await import("../scripts/seed.js");
      await seedCheckoutData();
      await seedDeliveryData();
      await Restaurant.updateOne(
        { slug: "spice-route-kitchen" },
        { openingTime: "00:00", closingTime: "00:00" },
      );
      rider = await createAndLogin(app, "delivery");
    });

    async function deliveredOrder() {
      const food = await FoodItem.findOne({ name: "Butter Chicken" });
      await request(app)
        .post("/api/v1/cart/items")
        .set(auth(as.customer.token))
        .send({ foodItemId: food.id, quantity: 1 });
      const address = await Address.findOne({ user: as.customer.user.id });
      const placed = await request(app)
        .post("/api/v1/orders")
        .set(auth(as.customer.token))
        .send({ addressId: String(address._id), paymentMethod: "cod" });
      const { order } = placed.body.data;
      for (const status of ["confirmed", "preparing", "ready_for_pickup"])
        await request(app)
          .patch(`/api/v1/my/restaurant/orders/${order.id}/status`)
          .set(auth(owner.token))
          .send({ status });
      await request(app)
        .patch("/api/v1/delivery/me/availability")
        .set(auth(rider.token))
        .send({ isOnline: true, ...NEAR });
      await request(app)
        .post(`/api/v1/delivery/offers/${order.id}/accept`)
        .set(auth(rider.token));
      for (const status of ["picked_up", "on_the_way", "delivered"])
        await request(app)
          .patch(`/api/v1/delivery/orders/${order.id}/status`)
          .set(auth(rider.token))
          .send(await riderStatusBody(order.id, status));
      return Order.findById(order.id);
    }

    it("shows the operations dashboard and delivery performance", async () => {
      await deliveredOrder();
      const dash = await get("/admin/operations/dashboard", "operations_admin");
      assert.equal(dash.body.data.orders.total, 1);
      assert.equal(dash.body.data.orders.completed, 1);
      assert.equal(dash.body.data.restaurants.total, 1);
      const perf = await get("/admin/operations/performance", "operations_admin");
      assert.equal(perf.body.data.totals.delivered, 1);
      assert.equal(perf.body.data.topRiders[0].deliveries, 1);
    });

    it("pays a restaurant once for each delivered order", async () => {
      const order = await deliveredOrder();
      const due = await get("/admin/finance/payouts/due?type=restaurant", "finance_admin");
      assert.equal(due.body.data.items.length, 1);
      const row = due.body.data.items[0];
      assert.equal(row.amountPaise, order.settlement.restaurantPaise);

      const pay = () =>
        request(app)
          .post("/api/v1/admin/finance/payouts")
          .set(auth(as.finance_admin.token))
          .send({ type: "restaurant", payeeId: row.payeeId });
      const created = await pay();
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.payout.amountPaise, order.settlement.restaurantPaise);
      assert.equal((await pay()).status, 400, "nothing left to pay");

      const id = created.body.data.payout.id;
      const paid = await request(app)
        .post(`/api/v1/admin/finance/payouts/${id}/paid`)
        .set(auth(as.finance_admin.token))
        .send({ reference: "UTR-12345" });
      assert.equal(paid.body.data.payout.status, "paid");
      const cancel = await request(app)
        .post(`/api/v1/admin/finance/payouts/${id}/cancel`)
        .set(auth(as.finance_admin.token))
        .send({});
      assert.equal(cancel.status, 409, "a paid payout stays paid");
      assert.ok(await AuditLog.exists({ action: "payout.paid", resourceId: id }));
    });

    it("cancelling a pending payout makes its orders due again", async () => {
      await deliveredOrder();
      const due = await get("/admin/finance/payouts/due?type=rider", "finance_admin");
      const created = await request(app)
        .post("/api/v1/admin/finance/payouts")
        .set(auth(as.finance_admin.token))
        .send({ type: "rider", payeeId: due.body.data.items[0].payeeId });
      await request(app)
        .post(`/api/v1/admin/finance/payouts/${created.body.data.payout.id}/cancel`)
        .set(auth(as.finance_admin.token))
        .send({ note: "Wrong account" });
      const again = await get("/admin/finance/payouts/due?type=rider", "finance_admin");
      assert.equal(again.body.data.items.length, 1);
    });

    it("lets a customer open a ticket only about their own order", async () => {
      const order = await deliveredOrder();
      const open = (body) =>
        request(app)
          .post("/api/v1/support/tickets")
          .set(auth(as.customer.token))
          .send({ type: "refund", subject: "Missing item", message: "One dish was missing.", ...body });
      const ok = await open({ orderNumber: order.orderNumber });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.data.ticket.orderNumber, order.orderNumber);
      assert.equal((await open({ orderNumber: "BB-000000-AAAAAA" })).status, 422);
    });
  });

  describe("support tickets", () => {
    const openTicket = async () =>
      (
        await request(app)
          .post("/api/v1/support/tickets")
          .set(auth(as.customer.token))
          .send({ type: "account", subject: "Cannot change email", message: "Please help me." })
      ).body.data.ticket;
    const staff = (method, path, body) =>
      request(app)[method](`/api/v1/admin/support${path}`)
        .set(auth(as.support_admin.token))
        .send(body);

    it("runs a ticket from open to resolved, hiding internal notes", async () => {
      const ticket = await openTicket();
      assert.equal(ticket.status, "open");
      assert.ok(await Notification.exists({ user: as.support_admin.user.id, type: "support.new" }));

      await staff("post", `/tickets/${ticket.id}/messages`, { body: "Checked the account.", internal: true });
      const reply = await staff("post", `/tickets/${ticket.id}/messages`, { body: "Which email should we use?" });
      assert.equal(reply.body.data.ticket.status, "waiting_for_response");
      assert.equal(reply.body.data.ticket.assignee.name, as.support_admin.user.name);

      const mine = await request(app)
        .get(`/api/v1/support/tickets/${ticket.id}`)
        .set(auth(as.customer.token));
      assert.equal(mine.body.data.ticket.messages.length, 2, "note hidden");
      assert.equal(mine.body.data.ticket.messages[1].authorName, "BiteBox Support");

      const answer = await request(app)
        .post(`/api/v1/support/tickets/${ticket.id}/messages`)
        .set(auth(as.customer.token))
        .send({ body: "The new one is nora@example.com" });
      assert.equal(answer.body.data.ticket.status, "in_progress");

      const done = await staff("patch", `/tickets/${ticket.id}`, { status: "resolved", priority: "low" });
      assert.equal(done.body.data.ticket.status, "resolved");
      assert.deepEqual(
        done.body.data.ticket.history.map((h) => h.action),
        ["created", "status", "status", "status", "priority"],
      );
      const dash = await staff("get", "/dashboard");
      assert.equal(dash.body.data.resolved, 1);
    });

    it("keeps other people's tickets private", async () => {
      const ticket = await openTicket();
      const rider = await createAndLogin(app, "delivery");
      const res = await request(app)
        .get(`/api/v1/support/tickets/${ticket.id}`)
        .set(auth(rider.token));
      assert.equal(res.status, 404);
      const admins = await request(app)
        .get("/api/v1/support/tickets")
        .set(auth(as.support_admin.token));
      assert.equal(admins.status, 403, "staff use the admin endpoints");
    });

    it("escalates a ticket to finance", async () => {
      const ticket = await openTicket();
      const res = await staff("post", `/tickets/${ticket.id}/escalate`, { note: "Please check the refund." });
      assert.equal(res.status, 200);
      assert.ok(await Notification.exists({ user: as.finance_admin.user.id, type: "support.escalated" }));
      assert.ok(await AuditLog.exists({ action: "ticket.escalate" }));
    });

    it("assigns only to admins who handle support", async () => {
      const ticket = await openTicket();
      const bad = await staff("patch", `/tickets/${ticket.id}`, { assigneeId: as.finance_admin.user.id });
      assert.equal(bad.status, 400);
      const good = await staff("patch", `/tickets/${ticket.id}`, { assigneeId: as.admin.user.id });
      assert.equal(good.body.data.ticket.assignee.name, as.admin.user.name);
    });
  });

  it("leaves a customer's sign-in password flow untouched", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "customer@bitebox.test", password: PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.role, "customer");
  });
});
