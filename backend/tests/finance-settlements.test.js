// Commission rules, payouts, refund deductions, the ledger, invoices and partner history (same
// contract as backend-django's apps/finance tests).
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Address } from "../models/address.model.js";
import { AuditLog } from "../models/audit-log.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { Invoice } from "../models/invoice.model.js";
import { LedgerEntry } from "../models/ledger-entry.model.js";
import { Notification } from "../models/notification.model.js";
import { Order, Payment } from "../models/order.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { flushPush } from "../services/push.service.js";
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

describe("finance: commission, payouts, refunds, ledger, invoices", () => {
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
    await Restaurant.updateOne({ slug: "spice-route-kitchen" }, { openingTime: "00:00", closingTime: "00:00" });
    customer = await createAndLogin(app, "customer");
    rider = await createAndLogin(app, "delivery");
    food = await FoodItem.findOne({ name: "Butter Chicken" });
  });

  const api = (token) => ({
    get: (url) => request(app).get(url).set(auth(token)),
    post: (url, body = {}) => request(app).post(url).set(auth(token)).send(body),
    put: (url, body) => request(app).put(url).set(auth(token)).send(body),
    patch: (url, body) => request(app).patch(url).set(auth(token)).send(body),
    del: (url) => request(app).delete(url).set(auth(token)),
  });
  async function deliver(paymentMethod = "cod") {
    await api(customer.token).post("/api/v1/cart/items", { foodItemId: food.id, quantity: 2 });
    const address = await Address.findOne({ user: customer.user.id, isDefault: true });
    const placed = await api(customer.token).post("/api/v1/orders", { addressId: String(address._id), paymentMethod });
    const id = placed.body.data.order.id;
    if (paymentMethod === "online")
      await api(customer.token).post(`/api/v1/payments/orders/${id}/mock`, { outcome: "success" });
    await api(rider.token).patch("/api/v1/delivery/me/availability", { isOnline: true, ...NEAR });
    for (const status of ["confirmed", "preparing", "ready_for_pickup"])
      await api(owner.token).patch(`/api/v1/my/restaurant/orders/${id}/status`, { status });
    assert.equal((await api(rider.token).post(`/api/v1/delivery/offers/${id}/accept`)).status, 200);
    for (const status of ["picked_up", "on_the_way", "delivered"])
      assert.equal(
        (await api(rider.token).patch(`/api/v1/delivery/orders/${id}/status`, await riderStatusBody(id, status))).status,
        200,
      );
    return Order.findById(id);
  }
  const finance = async () => api((await createAndLogin(app, "finance_admin")).token);
  const balances = async () => {
    const data = (await (await finance()).get("/api/v1/admin/finance/ledger")).body.data;
    assert.equal(data.balanced, true);
    return Object.fromEntries(data.accounts.map((a) => [a.account, a.balancePaise]));
  };

  it("settles a delivery and posts a balanced, immutable ledger group", async () => {
    const order = await deliver();
    const s = order.settlement;
    assert.equal(s.commissionBp, 1500);
    assert.equal(s.restaurantPaise + s.riderPaise + s.platformPaise, order.pricing.totalPaise);
    const b = await balances();
    assert.equal(b.customer_payments, order.pricing.totalPaise);
    assert.equal(b.restaurant_payable, -s.restaurantPaise);
    assert.equal(b.tax_payable, -order.pricing.taxPaise);
    assert.equal(Object.values(b).reduce((n, v) => n + v, 0), 0);
    await assert.rejects(LedgerEntry.updateMany({}, { amountPaise: 0 }), /LEDGER_IMMUTABLE/);
  });

  it("applies the global and per-restaurant commission rates", async () => {
    const f = await finance();
    assert.equal((await f.get("/api/v1/admin/finance/commission/rules")).body.data.global.basisPoints, 1500);
    const res = await f.put("/api/v1/admin/finance/commission/rules", { basisPoints: 1200, note: "Festival offer" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.global.percent, 12);
    const restaurant = await Restaurant.findOne({ slug: "spice-route-kitchen" });
    await f.put("/api/v1/admin/finance/commission/rules", { restaurantId: String(restaurant._id), basisPoints: 1000 });
    assert.equal((await deliver()).settlement.commissionBp, 1000, "the restaurant's own rate wins");
    const data = (await f.get("/api/v1/admin/finance/commission/rules")).body.data;
    assert.deepEqual(data.overrides.map((o) => o.restaurant.name), ["Spice Route Kitchen"]);
    assert.equal(data.history.length, 2);
    assert.equal((await f.del(`/api/v1/admin/finance/commission/rules/${restaurant._id}`)).status, 200);
    assert.equal((await f.del(`/api/v1/admin/finance/commission/rules/${restaurant._id}`)).status, 404);
    assert.equal(await AuditLog.countDocuments({ action: "commission.set" }), 2);
    assert.equal((await f.put("/api/v1/admin/finance/commission/rules", { basisPoints: 6000 })).status, 422);
    const ops = await createAndLogin(app, "operations_admin");
    assert.equal((await api(ops.token).get("/api/v1/admin/finance/commission/rules")).status, 403);
  });

  it("pays out due settlements once, posts it and tells the partner", async () => {
    const order = await deliver();
    const f = await finance();
    const restaurant = await Restaurant.findOne({ slug: "spice-route-kitchen" });
    const created = await f.post("/api/v1/admin/finance/payouts", { type: "restaurant", payeeId: String(restaurant._id) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const payout = created.body.data.payout;
    assert.equal(payout.amountPaise, order.settlement.restaurantPaise);
    const paid = await f.post(`/api/v1/admin/finance/payouts/${payout.id}/paid`, { reference: "UTR123456" });
    assert.equal(paid.body.data.payout.status, "paid");
    await flushPush();
    assert.ok(await Notification.exists({ user: owner.user.id, type: "payout.paid" }));
    assert.equal((await balances()).restaurant_payable, 0);

    const history = (await api(owner.token).get("/api/v1/my/restaurant/settlements")).body.data.items;
    assert.equal(history[0].orderNumber, order.orderNumber);
    assert.equal(history[0].payout.status, "paid");
    const mine = (await api(owner.token).get("/api/v1/my/restaurant/payouts")).body.data.items;
    assert.deepEqual(mine.map((p) => p.id), [payout.id]);
    const statement = await api(owner.token).get(`/api/v1/my/restaurant/payouts/${payout.id}/statement`);
    assert.equal(statement.status, 200);
    assert.equal(statement.headers["content-type"], "application/pdf");
    const text = statement.body.toString("latin1");
    assert.ok(text.startsWith("%PDF-1.4"));
    for (const cell of ["(Commission)", "(Refunds)", "(Total paid)"]) assert.ok(text.includes(cell), cell);
    assert.equal((await api(rider.token).get(`/api/v1/delivery/payouts/${payout.id}/statement`)).status, 404);
    const riderHistory = (await api(rider.token).get("/api/v1/delivery/settlements")).body.data.items;
    assert.equal(riderHistory[0].netPaise, order.settlement.riderPaise);
  });

  it("takes a refund after delivery off the restaurant's unpaid share", async () => {
    const order = await deliver("online");
    const payment = await Payment.findOne({ order: order._id });
    const f = await finance();
    const res = await f.post(`/api/v1/admin/payments/${payment._id}/refunds`, { amountPaise: 5000, reason: "Missing raita" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = await Order.findById(order._id);
    assert.equal(after.settlement.refundAdjustmentPaise, 5000);
    const due = (await f.get("/api/v1/admin/finance/payouts/due?type=restaurant")).body.data.items;
    assert.equal(due[0].amountPaise, order.settlement.restaurantPaise - 5000);
    const b = await balances();
    assert.equal(b.customer_payments, order.pricing.totalPaise - 5000);
    assert.equal(b.restaurant_payable, -(order.settlement.restaurantPaise - 5000));
  });

  it("lets customers download an invoice once delivered, with a stable number", async () => {
    const order = await deliver();
    const res = await api(customer.token).get(`/api/v1/orders/${order._id}/invoice`);
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "application/pdf");
    const text = res.body.toString("latin1");
    assert.ok(text.includes("Tax invoice") && text.includes("Spice Route Kitchen") && text.trimEnd().endsWith("%%EOF"));
    const { number } = await Invoice.findOne({ order: order._id });
    assert.match(number, /^BB\/INV\/20\d\d-\d\d\/000001$/);
    await api(customer.token).get(`/api/v1/orders/${order._id}/invoice`);
    assert.equal(await Invoice.countDocuments(), 1);
    const stranger = await registerUser(app);
    assert.equal((await api(stranger.token).get(`/api/v1/orders/${order._id}/invoice`)).status, 404);
    assert.equal((await (await finance()).get(`/api/v1/admin/orders/${order._id}/invoice`)).status, 200);
  });

  it("exports the settlement report as CSV", async () => {
    const order = await deliver();
    const csv = await (await finance()).get("/api/v1/admin/finance/settlements.csv");
    assert.match(csv.headers["content-type"], /^text\/csv/);
    const lines = csv.text.trim().split(/\r\n/);
    assert.match(lines[0], /^Order,Delivered at/);
    assert.ok(lines[1].startsWith(order.orderNumber));
  });
});
