// Order lifecycle additions (same contract as backend-django's test_lifecycle.py): the rider's
// arrival at the restaurant, the delivery code, the restaurant's preparation time, manual
// assignment by an admin, the order timeline and the restaurant's dashboard figures.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { DISPATCH } from "../config/dispatch.js";
import { env } from "../config/env.js";
import { Address } from "../models/address.model.js";
import { AuditLog } from "../models/audit-log.model.js";
import { DeliveryPartner } from "../models/delivery-partner.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { Notification } from "../models/notification.model.js";
import { Order } from "../models/order.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { sweep } from "../services/dispatch.service.js";
import { canTransition } from "../services/order-workflow.service.js";
import {
  buildApp,
  createAndLogin,
  registerUser,
  request,
  resetDb,
  riderStatusBody,
  seedCatalogFor,
  setupTestDb,
  teardownTestDb,
} from "./helpers.js";

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const NEAR = { latitude: 12.9729, longitude: 77.6412 };
const FARTHER = { latitude: 12.9899, longitude: 77.6412 };

describe("order lifecycle: arrival, delivery code, prep time, assignment, timeline", () => {
  let app;
  let customer;
  let owner;
  let rider;
  let food;

  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(teardownTestDb);

  beforeEach(async () => {
    await resetDb();
    owner = await seedCatalogFor(app);
    const { seedCheckoutData, seedDeliveryData } = await import("../scripts/seed.js");
    await seedCheckoutData();
    await seedDeliveryData();
    await Restaurant.updateOne(
      { slug: "spice-route-kitchen" },
      { openingTime: "00:00", closingTime: "00:00" },
    );
    customer = await createAndLogin(app, "customer");
    rider = await createAndLogin(app, "delivery");
    food = Object.fromEntries((await FoodItem.find()).map((f) => [f.name, f]));
  });

  const api = (token) => ({
    get: (url) => request(app).get(url).set(auth(token)),
    post: (url, body = {}) => request(app).post(url).set(auth(token)).send(body),
    patch: (url, body) => request(app).patch(url).set(auth(token)).send(body),
  });
  async function placeOrder() {
    await api(customer.token).post("/api/v1/cart/items", {
      foodItemId: food["Butter Chicken"].id,
      quantity: 2,
    });
    const address = await Address.findOne({ user: customer.user.id, isDefault: true });
    const res = await api(customer.token).post("/api/v1/orders", {
      addressId: String(address._id),
      paymentMethod: "cod",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data.order.id;
  }
  const restaurantSet = (id, body) =>
    api(owner.token).patch(`/api/v1/my/restaurant/orders/${id}/status`, body);
  const goOnline = (token, where = NEAR) =>
    api(token).patch("/api/v1/delivery/me/availability", { isOnline: true, ...where });
  const riderSet = async (token, id, status, otp) =>
    api(token).patch(`/api/v1/delivery/orders/${id}/status`, await riderStatusBody(id, status, otp));
  const dashboard = (token) => api(token).get("/api/v1/delivery/me");
  async function readyOrder() {
    const id = await placeOrder();
    for (const status of ["confirmed", "preparing", "ready_for_pickup"])
      assert.equal((await restaurantSet(id, { status })).status, 200);
    return id;
  }
  async function assigned() {
    await goOnline(rider.token);
    const id = await readyOrder();
    const res = await api(rider.token).post(`/api/v1/delivery/offers/${id}/accept`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return id;
  }
  const admin = async (role = "admin") => api((await createAndLogin(app, role)).token);
  const wrongCode = (code) => (code === "0000" ? "1111" : "0000");

  // -- arrival -----------------------------------------------------------------------------------
  it("lets the rider mark arrival, then pickup", async () => {
    const id = await assigned();
    const offer = await dashboard(rider.token);
    assert.deepEqual(offer.body.data.activeOrder.nextStatuses, ["arrived_at_restaurant", "picked_up"]);
    assert.equal(offer.body.data.activeOrder.deliveryOtpRequired, false);
    assert.ok(offer.body.data.activeOrder.estimatedEarningsPaise > 0);

    const arrived = await riderSet(rider.token, id, "arrived_at_restaurant");
    assert.equal(arrived.status, 200, JSON.stringify(arrived.body));
    assert.match(arrived.body.message, /^Marked as arrived/);
    assert.deepEqual(arrived.body.data.activeOrder.nextStatuses, ["picked_up"]);
    assert.ok(
      await Notification.exists({ user: owner.user.id, title: /^Rider has arrived/ }),
      "the restaurant is told",
    );
    const board = await api(owner.token).get(`/api/v1/my/restaurant/orders/${id}`);
    assert.equal(board.body.data.order.status, "arrived_at_restaurant");
    assert.ok(board.body.data.order.pickupBy);

    assert.equal((await riderSet(rider.token, id, "picked_up")).status, 200);
    assert.ok(canTransition("assigned", "picked_up", "delivery"), "arrival is optional");
    assert.ok(!canTransition("arrived_at_restaurant", "on_the_way", "delivery"));
  });

  it("still times out an order waiting at the counter", async () => {
    const id = await assigned();
    await riderSet(rider.token, id, "arrived_at_restaurant");
    const summary = await sweep(new Date(Date.now() + (DISPATCH.pickupWindowMinutes + 1) * 60_000));
    assert.equal(summary.pickupExpired, 1);
    assert.equal((await Order.findById(id)).status, "cancelled");
  });

  // -- delivery code -----------------------------------------------------------------------------
  it("needs the customer's code to mark delivered", async () => {
    const id = await assigned();
    await riderSet(rider.token, id, "picked_up");
    const code = (await Order.findById(id)).deliveryOtp;
    assert.match(code, /^\d{4}$/);

    const mine = await api(customer.token).get(`/api/v1/orders/${id}`);
    assert.equal(mine.body.data.order.deliveryOtp, code, "only the customer sees it");
    const riderView = (await dashboard(rider.token)).body.data.activeOrder;
    assert.equal(riderView.deliveryOtpRequired, true);
    assert.equal(riderView.deliveryOtp, undefined);
    const adminView = (await (await admin()).get(`/api/v1/admin/orders/${id}`)).body.data.order;
    assert.equal(adminView.deliveryOtp, undefined);
    assert.equal(adminView.deliveryOtpPending, true);
    assert.ok(
      await Notification.exists({ user: customer.user.id, body: new RegExp(code) }),
      "the pickup notice carries the code",
    );

    await riderSet(rider.token, id, "on_the_way");
    const missing = await api(rider.token).patch(`/api/v1/delivery/orders/${id}/status`, {
      status: "delivered",
    });
    assert.equal(missing.status, 422);
    assert.deepEqual(missing.body.error.details[0], {
      field: "otp",
      message: "Ask the customer for their delivery code",
    });
    const bad = await riderSet(rider.token, id, "delivered", wrongCode(code));
    assert.equal(bad.status, 422);
    assert.match(bad.body.error.details[0].message, /3 tries left/); // the empty try counted too
    assert.equal((await Order.findById(id)).status, "on_the_way");
    assert.equal((await riderSet(rider.token, id, "delivered", "12x4")).status, 422);

    const done = await riderSet(rider.token, id, "delivered", code);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await Order.findById(id)).status, "delivered");
    const after = await api(customer.token).get(`/api/v1/orders/${id}`);
    assert.equal(after.body.data.order.deliveryOtp, null, "no longer shown once delivered");
  });

  it("locks after too many wrong codes until support sends a new one", async () => {
    const id = await assigned();
    for (const status of ["picked_up", "on_the_way"]) await riderSet(rider.token, id, status);
    const code = (await Order.findById(id)).deliveryOtp;
    for (let i = 0; i < env.deliveryOtp.maxAttempts; i++)
      assert.equal((await riderSet(rider.token, id, "delivered", wrongCode(code))).status, 422);
    const locked = await riderSet(rider.token, id, "delivered", code);
    assert.equal(locked.status, 409, "even the right code now");
    assert.equal(locked.body.error.code, "OTP_LOCKED");

    const support = await admin();
    const reset = await support.post(`/api/v1/admin/orders/${id}/delivery-code`);
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.message, "New delivery code sent to the customer");
    const order = await Order.findById(id);
    assert.equal(order.deliveryOtpAttempts, 0);
    assert.ok(await Notification.exists({ type: "order.delivery_code", body: new RegExp(order.deliveryOtp) }));
    assert.ok(await AuditLog.exists({ action: "order.delivery_code" }));
    assert.equal((await riderSet(rider.token, id, "delivered", order.deliveryOtp)).status, 200);
    assert.equal((await support.post(`/api/v1/admin/orders/${id}/delivery-code`)).status, 409);
  });

  it("can switch the code off", async () => {
    env.deliveryOtp.required = false;
    try {
      const id = await assigned();
      for (const status of ["picked_up", "on_the_way"]) await riderSet(rider.token, id, status);
      assert.equal((await Order.findById(id)).deliveryOtp, null);
      const res = await api(rider.token).patch(`/api/v1/delivery/orders/${id}/status`, {
        status: "delivered",
      });
      assert.equal(res.status, 200);
    } finally {
      env.deliveryOtp.required = true;
    }
  });

  // -- preparation time --------------------------------------------------------------------------
  it("takes a preparation time when the restaurant accepts", async () => {
    const id = await placeOrder();
    const before = Date.now();
    const res = await restaurantSet(id, { status: "confirmed", prepMinutes: 25 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.order.prepMinutes, 25);
    const readyBy = (await Order.findById(id)).readyBy.getTime() - before;
    assert.ok(readyBy > 24 * 60_000 && readyBy < 26 * 60_000);
    const mine = await api(customer.token).get(`/api/v1/orders/${id}`);
    assert.ok(mine.body.data.order.readyBy, "the customer sees when it should be ready");

    const other = await placeOrder();
    await restaurantSet(other, { status: "confirmed" });
    const usual = (await Restaurant.findOne({ slug: "spice-route-kitchen" })).avgPrepTimeMinutes;
    assert.equal((await Order.findById(other)).prepMinutes, usual, "the usual time");

    const tooLong = await restaurantSet(await placeOrder(), { status: "confirmed", prepMinutes: 500 });
    assert.equal(tooLong.status, 422);
    assert.equal(tooLong.body.error.details[0].message, "Preparation time must be 5 to 120 minutes");
  });

  // -- manual assignment -------------------------------------------------------------------------
  it("lets an admin assign a chosen rider", async () => {
    const otherToken = (await registerUser(app, { role: "delivery", name: "Second Rider" })).token;
    await request(app)
      .put("/api/v1/delivery/me/vehicle")
      .set(auth(otherToken))
      .send({ vehicleType: "scooter", vehicleNumber: "KA 02 CC 1234" });
    await goOnline(otherToken, FARTHER);
    await goOnline(rider.token);
    const id = await readyOrder(); // offered to the nearer rider
    assert.equal(String((await Order.findById(id)).offer.partner), rider.user.id);
    const otherId = (await api(otherToken).get("/api/v1/auth/me")).body.data.user.id;

    const support = await admin();
    const detail = await support.get(`/api/v1/admin/orders/${id}`);
    assert.equal(detail.body.data.order.canAssign, true);
    const res = await support.post(`/api/v1/admin/orders/${id}/assign`, { riderId: otherId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.message, "Rider assigned");
    const order = res.body.data.order;
    assert.deepEqual([order.status, order.deliveryPartner, order.canAssign], ["assigned", otherId, false]);
    // The open offer was withdrawn and its rider freed; the new rider carries the order.
    assert.equal((await DeliveryPartner.findOne({ user: rider.user.id })).currentOffer, null);
    assert.equal(String((await DeliveryPartner.findOne({ user: otherId })).activeOrder), id);
    assert.ok(await AuditLog.exists({ action: "order.assign" }));
    assert.equal((await dashboard(otherToken)).body.data.activeOrder.id, id);
    assert.equal((await riderSet(otherToken, id, "picked_up")).status, 200);
  });

  it("assigns only waiting orders to free riders", async () => {
    const support = await admin();
    const pending = await placeOrder();
    const early = await support.post(`/api/v1/admin/orders/${pending}/assign`, { riderId: rider.user.id });
    assert.equal(early.status, 409);

    const id = await readyOrder(); // nobody online: no offer
    const offline = await support.post(`/api/v1/admin/orders/${id}/assign`, { riderId: rider.user.id });
    assert.equal(offline.status, 409);
    assert.equal(offline.body.error.code, "RIDER_UNAVAILABLE");
    const notRider = await support.post(`/api/v1/admin/orders/${id}/assign`, { riderId: customer.user.id });
    assert.equal(notRider.status, 404);
    assert.equal((await support.post(`/api/v1/admin/orders/${id}/assign`, {})).status, 422);
    const supportOnly = await admin("support_admin");
    const denied = await supportOnly.post(`/api/v1/admin/orders/${id}/assign`, { riderId: rider.user.id });
    assert.equal(denied.status, 403, "orders:manage only");
  });

  // -- timeline ----------------------------------------------------------------------------------
  it("shows the order timeline", async () => {
    const id = await assigned();
    await riderSet(rider.token, id, "arrived_at_restaurant");
    const res = await api(customer.token).get(`/api/v1/orders/${id}/timeline`);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.data.events.map((e) => e.label),
      [
        "Order placed",
        "Accepted by the restaurant",
        "Being prepared",
        "Ready for pickup",
        "Rider assigned",
        "Rider at the restaurant",
      ],
    );
    assert.equal(res.body.data.events[1].by, "restaurant");
    assert.ok(res.body.data.readyBy);
    const stranger = await registerUser(app);
    assert.equal((await api(stranger.token).get(`/api/v1/orders/${id}/timeline`)).status, 404);
    assert.equal((await (await admin()).get(`/api/v1/admin/orders/${id}/timeline`)).status, 200);
  });

  // -- restaurant dashboard figures ---------------------------------------------------------------
  it("gives the restaurant its order figures", async () => {
    const id = await assigned();
    for (const status of ["picked_up", "on_the_way", "delivered"]) await riderSet(rider.token, id, status);
    await placeOrder(); // still waiting
    const res = await api(owner.token).get("/api/v1/my/restaurant/stats");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const s = res.body.data;
    assert.deepEqual(
      [s.totalOrders, s.todayOrders, s.pendingOrders, s.completedOrders, s.cancelledOrders],
      [2, 2, 1, 1, 0],
    );
    const delivered = await Order.findById(id);
    assert.equal(s.salesPaise, delivered.pricing.subtotalPaise - (delivered.pricing.discountPaise ?? 0));
    assert.equal(s.averageOrderPaise, s.salesPaise);
    assert.equal((await api(customer.token).get("/api/v1/my/restaurant/stats")).status, 403);
  });

  // -- dashboards (rider stats, admin home, sign-in history) ---------------------------------------
  it("gives the rider today's, this week's and all-time figures", async () => {
    const empty = await api(rider.token).get("/api/v1/delivery/stats");
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body.data.today, { deliveries: 0, earningsPaise: 0 });
    const id = await assigned();
    for (const status of ["picked_up", "on_the_way", "delivered"]) await riderSet(rider.token, id, status);
    const earned = (await Order.findById(id)).settlement.riderPaise;
    const s = (await api(rider.token).get("/api/v1/delivery/stats")).body.data;
    for (const w of ["today", "week", "total"])
      assert.deepEqual(s[w], { deliveries: 1, earningsPaise: earned }, w);
    assert.deepEqual(Object.keys(s.rating), ["average", "count"]);
    assert.equal((await api(customer.token).get("/api/v1/delivery/stats")).status, 403);
  });

  it("shows admins the platform figures, money only with finance:view", async () => {
    const id = await assigned();
    for (const status of ["picked_up", "on_the_way", "delivered"]) await riderSet(rider.token, id, status);
    await placeOrder();
    const finance = await (await admin("finance_admin")).get("/api/v1/admin/dashboard");
    assert.equal(finance.status, 200, JSON.stringify(finance.body));
    const d = finance.body.data;
    assert.deepEqual(d.orders, { total: 2, active: 1, completed: 1, cancelled: 0 });
    assert.ok(d.customers >= 1 && d.restaurants >= 1 && d.deliveryPartners >= 1);
    const order = await Order.findById(id);
    assert.equal(d.money.gmvPaise, order.pricing.totalPaise);
    assert.equal(d.money.platformRevenuePaise, order.settlement.platformPaise);
    assert.equal(
      d.money.pendingSettlementsPaise,
      order.settlement.restaurantPaise + order.settlement.riderPaise,
    );
    const support = (await (await admin("support_admin")).get("/api/v1/admin/dashboard")).body.data;
    assert.equal(support.money, undefined, "no money without finance:view");
    assert.equal((await api(customer.token).get("/api/v1/admin/dashboard")).status, 403);
  });

  it("lists an account's sign-ins for admins", async () => {
    const boss = await admin();
    const res = await boss.get(`/api/v1/admin/users/${customer.user.id}/logins`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [latest] = res.body.data.items;
    assert.equal(latest.active, true);
    assert.equal(latest.endedReason, null);
    assert.ok(latest.signedInAt && latest.lastActiveAt);
    assert.equal(res.body.data.pagination.total, res.body.data.items.length);
    // Staff sign-ins live under /admin/admins; a member id there is not found, and vice versa.
    const ops = await createAndLogin(app, "operations_admin");
    assert.equal((await boss.get(`/api/v1/admin/admins/${ops.user.id}/logins`)).status, 200);
    assert.equal((await boss.get(`/api/v1/admin/admins/${customer.user.id}/logins`)).status, 404);
    assert.equal((await boss.get(`/api/v1/admin/users/${ops.user.id}/logins`)).status, 404);
    const support = await admin("support_admin"); // no users:manage
    assert.equal((await support.get(`/api/v1/admin/users/${customer.user.id}/logins`)).status, 403);
  });
});
