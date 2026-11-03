import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { DISPATCH } from "../src/config/dispatch.js";
import { EARNINGS } from "../src/config/earnings.js";
import { Address } from "../src/models/address.model.js";
import { FoodItem } from "../src/models/food-item.model.js";
import { Notification } from "../src/models/notification.model.js";
import { Order, Payment } from "../src/models/order.model.js";
import { Restaurant } from "../src/models/restaurant.model.js";
import { sweep } from "../src/services/dispatch.service.js";
import { settlementFor } from "../src/services/earnings.service.js";
import { useOnlineProvider } from "../src/services/payments/payment.service.js";
import { createRazorpayProvider } from "../src/services/payments/razorpay.provider.js";
import { buildApp, createAndLogin, registerUser, request, resetDb, seedCatalogFor, setupTestDb, teardownTestDb } from "./helpers.js";

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const NEAR = { latitude: 12.9729, longitude: 77.6412 };
const KEY_SECRET = "test_key_secret_123";
const WEBHOOK_SECRET = "test_webhook_secret_456";
const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("hex");

describe("payments, notifications and earnings", () => {
  let app;
  let customer;
  let owner;
  let rider;

  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(teardownTestDb);

  beforeEach(async () => {
    await resetDb();
    owner = await seedCatalogFor(app);
    const { seedCheckoutData, seedDeliveryData } = await import("../src/scripts/seed.js");
    await seedCheckoutData();
    await seedDeliveryData();
    await Restaurant.updateOne({ slug: "spice-route-kitchen" }, { openingTime: "00:00", closingTime: "00:00" });
    customer = await createAndLogin(app, "customer");
    rider = await createAndLogin(app, "delivery");
  });

  async function placeOrder(paymentMethod = "online", token = customer.token, userId = customer.user.id) {
    const food = await FoodItem.findOne({ name: "Butter Chicken" });
    await request(app).post("/api/v1/cart/items").set(auth(token)).send({ foodItemId: food.id, quantity: 2 });
    const address = await Address.findOne({ user: userId });
    const res = await request(app).post("/api/v1/orders").set(auth(token)).send({ addressId: String(address._id), paymentMethod });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  }
  const mockPay = (id, outcome) => request(app).post(`/api/v1/payments/orders/${id}/mock`).set(auth(customer.token)).send({ outcome });
  const restaurantOrders = () => request(app).get("/api/v1/my/restaurant/orders").set(auth(owner.token));

  it("offers cash and the simulated online payment in development", async () => {
    const res = await request(app).get("/api/v1/payments/methods");
    const methods = res.body.data.methods;
    assert.deepEqual(methods.map((m) => m.method), ["cod", "online"]);
    assert.equal(methods[1].provider, "mock");
    assert.equal(methods[1].simulated, true, "clearly labelled as simulated");
  });

  describe("simulated online payment", () => {
    it("keeps the order from the restaurant until it is paid", async () => {
      const { order, checkout } = await placeOrder();
      assert.equal(checkout.provider, "mock");
      assert.ok(checkout.providerOrderId.startsWith("mock_order_"));
      assert.equal((await restaurantOrders()).body.data.items.length, 0, "unpaid: invisible to the restaurant");
      const blocked = await request(app).patch(`/api/v1/my/restaurant/orders/${order.id}/status`).set(auth(owner.token)).send({ status: "confirmed" });
      assert.equal(blocked.status, 404);

      const paid = await mockPay(order.id, "success");
      assert.equal(paid.body.data.payment.status, "paid");
      const saved = await Order.findById(order.id);
      assert.equal(saved.paymentStatus, "paid");
      assert.ok(saved.submittedAt);
      assert.equal((await restaurantOrders()).body.data.items[0].id, order.id, "paid: the restaurant sees it");
      assert.equal(await Notification.countDocuments({ user: owner.user.id, type: "order.new" }), 1, "restaurant notified");

      const again = await mockPay(order.id, "success");
      assert.equal(again.body.data.payment.status, "paid", "repeating is harmless");
      assert.equal(await Notification.countDocuments({ user: owner.user.id, type: "order.new" }), 1, "notified once");
    });

    it("can fail and be retried", async () => {
      const { order } = await placeOrder();
      assert.equal((await mockPay(order.id, "failure")).body.data.payment.status, "failed");
      assert.equal((await Order.findById(order.id)).submittedAt, null);
      const view = await request(app).get(`/api/v1/orders/${order.id}`).set(auth(customer.token));
      assert.equal(view.body.data.order.payment.status, "failed");
      assert.equal((await mockPay(order.id, "success")).body.data.payment.status, "paid");
    });

    it("cancels orders that are never paid", async () => {
      const { order } = await placeOrder();
      const summary = await sweep(new Date(Date.now() + (DISPATCH.paymentWindowMinutes + 1) * 60_000));
      assert.equal(summary.unpaidCancelled, 1);
      const saved = await Order.findById(order.id);
      assert.equal(saved.status, "cancelled");
      assert.equal(saved.cancellation.by, "system");
      assert.equal((await Payment.findOne({ order: order.id })).status, "cancelled");
      assert.equal((await mockPay(order.id, "success")).status, 409, "too late to pay");
    });

    it("closing the payment page cancels the attempt and refills the cart", async () => {
      const { order } = await placeOrder();
      const abandon = () => request(app).post(`/api/v1/payments/orders/${order.id}/abandon`).set(auth(customer.token));
      const res = await abandon();
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.restored, true);
      assert.equal((await Order.findById(order.id)).status, "cancelled");
      const cart = await request(app).get("/api/v1/cart").set(auth(customer.token));
      assert.equal(cart.body.data.cart.items[0].quantity, 2, "dishes are back in the cart");
      const mine = await request(app).get("/api/v1/orders").set(auth(customer.token));
      assert.equal(mine.body.data.items.length, 0, "never shown as an order");
      assert.equal((await abandon()).body.data.restored, false, "repeating is harmless");
      assert.equal(await Notification.countDocuments({ user: owner.user.id }), 0, "restaurant never hears of it");

      const paid = (await placeOrder()).order;
      await mockPay(paid.id, "success");
      const late = await request(app).post(`/api/v1/payments/orders/${paid.id}/abandon`).set(auth(customer.token));
      assert.equal(late.status, 409, "a paid order cannot be abandoned");
    });

    it("refunds a paid order the restaurant rejects", async () => {
      const { order } = await placeOrder();
      await mockPay(order.id, "success");
      await request(app).patch(`/api/v1/my/restaurant/orders/${order.id}/status`).set(auth(owner.token)).send({ status: "rejected", reason: "Kitchen closed early" });
      const payment = await Payment.findOne({ order: order.id });
      assert.equal(payment.status, "refunded");
      assert.ok(payment.providerRefundId);
      assert.equal((await Order.findById(order.id)).paymentStatus, "refunded");
      assert.equal(await Notification.countDocuments({ user: customer.user.id, type: "order.rejected" }), 1, "customer told");
    });

    it("only lets the order's customer pay", async () => {
      const { order } = await placeOrder();
      const stranger = await registerUser(app);
      const res = await request(app).post(`/api/v1/payments/orders/${order.id}/mock`).set(auth(stranger.token)).send({ outcome: "success" });
      assert.equal(res.status, 404);
    });
  });

  describe("Razorpay (fake gateway client)", () => {
    let gateway;
    let restore;
    beforeEach(() => {
      gateway = { payment: null, refunds: [] };
      const client = {
        orders: { create: async ({ amount }) => ({ id: "order_TEST123", amount, currency: "INR" }) },
        payments: {
          fetch: async (id) => ({ id, ...gateway.payment }),
          refund: async (id, { amount }) => {
            gateway.refunds.push({ id, amount });
            return { id: "rfnd_TEST1" };
          },
        },
      };
      restore = useOnlineProvider(createRazorpayProvider({ keyId: "rzp_test_key", keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }, client));
    });
    afterEach(() => restore?.()); // one swap per test, so each restore puts the simulated provider back

    const confirm = (id, body) => request(app).post(`/api/v1/payments/orders/${id}/confirm`).set(auth(customer.token)).send(body);

    it("verifies the signature and the payment itself before marking paid", async () => {
      const { order, checkout } = await placeOrder();
      assert.equal(checkout.provider, "razorpay");
      assert.equal(checkout.keyId, "rzp_test_key", "public key only");
      const amount = checkout.amountPaise;

      const forged = await confirm(order.id, { providerPaymentId: "pay_TEST1", signature: "0".repeat(64) });
      assert.equal(forged.status, 400);
      assert.equal(forged.body.error.code, "SIGNATURE_INVALID");

      const signature = hmac(KEY_SECRET, `order_TEST123|pay_TEST1`);
      gateway.payment = { status: "captured", amount: amount - 100, order_id: "order_TEST123" };
      const short = await confirm(order.id, { providerPaymentId: "pay_TEST1", signature });
      assert.equal(short.body.error.code, "PAYMENT_MISMATCH", "amount must match");

      gateway.payment = { status: "captured", amount, order_id: "order_TEST123" };
      const ok = await confirm(order.id, { providerPaymentId: "pay_TEST1", signature });
      assert.equal(ok.body.data.payment.status, "paid");
      assert.ok((await Order.findById(order.id)).submittedAt);
    });

    it("accepts signed webhooks once and rejects unsigned ones", async () => {
      const { order, checkout } = await placeOrder();
      const raw = JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_TEST2", order_id: "order_TEST123", amount: checkout.amountPaise } } },
      });
      const send = (signature) =>
        request(app)
          .post("/api/v1/payments/webhooks/razorpay")
          .set("Content-Type", "application/json")
          .set("X-Razorpay-Signature", signature)
          .set("X-Razorpay-Event-Id", "evt_1")
          .send(raw);

      assert.equal((await send("bad")).status, 400);
      const first = await send(hmac(WEBHOOK_SECRET, raw));
      assert.equal(first.body.data.processed, true);
      assert.equal((await Payment.findOne({ order: order.id })).status, "paid");
      const replay = await send(hmac(WEBHOOK_SECRET, raw));
      assert.equal(replay.body.data.duplicate, true, "same event id is ignored");
    });

    it("refunds a payment that arrives after the order expired", async () => {
      const { order, checkout } = await placeOrder();
      await sweep(new Date(Date.now() + (DISPATCH.paymentWindowMinutes + 1) * 60_000));
      const raw = JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_LATE", order_id: "order_TEST123", amount: checkout.amountPaise } } },
      });
      await request(app)
        .post("/api/v1/payments/webhooks/razorpay")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", hmac(WEBHOOK_SECRET, raw))
        .set("X-Razorpay-Event-Id", "evt_late")
        .send(raw);
      assert.deepEqual(gateway.refunds, [{ id: "pay_LATE", amount: checkout.amountPaise }], "money returned");
      assert.equal((await Payment.findOne({ order: order.id })).status, "refunded");
      assert.equal((await Order.findById(order.id)).status, "cancelled", "the expired order stays cancelled");
    });

    it("refunds through the gateway when a paid order is cancelled", async () => {
      const { order, checkout } = await placeOrder();
      gateway.payment = { status: "captured", amount: checkout.amountPaise, order_id: "order_TEST123" };
      await confirm(order.id, { providerPaymentId: "pay_TEST3", signature: hmac(KEY_SECRET, "order_TEST123|pay_TEST3") });
      const admin = await createAndLogin(app, "admin");
      await request(app).post(`/api/v1/admin/orders/${order.id}/cancel`).set(auth(admin.token)).send({ reason: "Customer request" });
      assert.deepEqual(gateway.refunds, [{ id: "pay_TEST3", amount: checkout.amountPaise }]);
      assert.equal((await Payment.findOne({ order: order.id })).status, "refunded");
    });
  });

  it("cancels orders no rider picks up in time, refunding and freeing the rider", async () => {
    const ready = async (paymentMethod) => {
      const { order } = await placeOrder(paymentMethod);
      if (paymentMethod === "online") await mockPay(order.id, "success");
      for (const status of ["confirmed", "preparing", "ready_for_pickup"]) {
        await request(app).patch(`/api/v1/my/restaurant/orders/${order.id}/status`).set(auth(owner.token)).send({ status });
      }
      return order.id;
    };
    await request(app).patch("/api/v1/delivery/me/availability").set(auth(rider.token)).send({ isOnline: true, ...NEAR });
    const accepted = await ready("online"); // the only rider takes it, then never picks it up
    const acceptRes = await request(app).post(`/api/v1/delivery/offers/${accepted}/accept`).set(auth(rider.token));
    assert.equal(acceptRes.status, 200, JSON.stringify(acceptRes.body));
    const unclaimed = await ready("cod"); // no free rider: nobody is ever offered it

    const early = await sweep(new Date(Date.now() + (DISPATCH.pickupWindowMinutes - 1) * 60_000));
    assert.equal(early.pickupExpired, 0, "still inside the pickup window");

    const summary = await sweep(new Date(Date.now() + (DISPATCH.pickupWindowMinutes + 1) * 60_000));
    assert.equal(summary.pickupExpired, 2);
    for (const id of [unclaimed, accepted]) {
      const saved = await Order.findById(id);
      assert.equal(saved.status, "cancelled");
      assert.equal(saved.cancellation.by, "system");
      assert.match(saved.cancellation.reason, /No delivery partner/);
    }
    assert.equal((await Payment.findOne({ order: accepted })).status, "refunded", "paid online: refunded");
    const me = await request(app).get("/api/v1/delivery/me").set(auth(rider.token));
    assert.equal(me.body.data.activeOrder ?? null, null, "the rider is free again");
    assert.equal(await Notification.countDocuments({ user: customer.user.id, type: "order.cancelled" }), 2, "customer told");
  });

  it("records the settlement on delivery and reports earnings", async () => {
    const admin = await createAndLogin(app, "admin");
    const { order } = await placeOrder("cod");
    for (const status of ["confirmed", "preparing", "ready_for_pickup"]) {
      await request(app).patch(`/api/v1/my/restaurant/orders/${order.id}/status`).set(auth(owner.token)).send({ status });
    }
    await request(app).patch("/api/v1/delivery/me/availability").set(auth(rider.token)).send({ isOnline: true, ...NEAR });
    await request(app).post(`/api/v1/delivery/offers/${order.id}/accept`).set(auth(rider.token));
    for (const status of ["picked_up", "on_the_way", "delivered"]) {
      await request(app).patch(`/api/v1/delivery/orders/${order.id}/status`).set(auth(rider.token)).send({ status });
    }

    const saved = await Order.findById(order.id);
    const expected = settlementFor(saved);
    assert.equal(saved.settlement.restaurantPaise, expected.restaurantPaise);
    const food = saved.pricing.subtotalPaise - saved.pricing.discountPaise;
    assert.equal(expected.restaurantPaise, Math.round(food * (1 - EARNINGS.restaurantCommissionBasisPoints / 10_000)));
    assert.equal(expected.riderPaise, EARNINGS.riderBasePaise + Math.ceil(saved.distanceMeters / 1000) * EARNINGS.riderPerKmPaise);
    assert.equal(expected.restaurantPaise + expected.riderPaise + expected.platformPaise, saved.pricing.totalPaise, "every paisa accounted for");
    assert.equal((await Payment.findOne({ order: order.id })).status, "paid", "cash collected");

    const restaurantEarnings = await request(app).get("/api/v1/my/restaurant/earnings?days=7").set(auth(owner.token));
    assert.equal(restaurantEarnings.body.data.totals.orders, 1);
    assert.equal(restaurantEarnings.body.data.totals.earningsPaise, expected.restaurantPaise);
    assert.equal(restaurantEarnings.body.data.daily.length, 7, "one entry per day, including quiet ones");

    const riderEarnings = await request(app).get("/api/v1/delivery/earnings").set(auth(rider.token));
    assert.equal(riderEarnings.body.data.totals.earningsPaise, expected.riderPaise);

    const report = await request(app).get("/api/v1/admin/reports?days=7").set(auth(admin.token));
    assert.equal(report.body.data.totals.delivered, 1);
    assert.equal(report.body.data.totals.gmvPaise, saved.pricing.totalPaise);
    assert.equal(report.body.data.totals.platformRevenuePaise, expected.platformPaise);
    assert.equal(report.body.data.paymentMix[0].method, "cod");
    assert.equal(report.body.data.topRestaurants[0].name, "Spice Route Kitchen");
    assert.equal((await request(app).get("/api/v1/admin/reports").set(auth(owner.token))).status, 403, "admins only");

    // The customer was told at each step, and can mark it all read.
    const inbox = await request(app).get("/api/v1/notifications").set(auth(customer.token));
    assert.deepEqual(
      inbox.body.data.items.map((n) => n.type).reverse(),
      ["order.placed", "order.confirmed", "order.assigned", "order.picked_up", "order.delivered"],
    );
    assert.equal(inbox.body.data.unread, 5);
    // Every other role heard about its part of the order.
    const types = async (token) => (await request(app).get("/api/v1/notifications").set(auth(token))).body.data.items.map((n) => n.type).reverse();
    assert.deepEqual(await types(owner.token), ["order.new", "order.assigned", "order.picked_up", "order.delivered"]);
    assert.deepEqual(await types(rider.token), ["order.offer"]);
    assert.deepEqual(await types(admin.token), ["order.new", "order.delivered"]);
    await request(app).patch(`/api/v1/notifications/${inbox.body.data.items[0].id}/read`).set(auth(customer.token));
    const unreadOnly = await request(app).get("/api/v1/notifications?unread=true").set(auth(customer.token));
    assert.equal(unreadOnly.body.data.items.length, 4, "the Unread tab leaves out the one just read");
    assert.ok(unreadOnly.body.data.items.every((n) => !n.readAt));
    await request(app).post("/api/v1/notifications/read-all").set(auth(customer.token));
    assert.equal((await request(app).get("/api/v1/notifications").set(auth(customer.token))).body.data.unread, 0);
    const others = await request(app).patch(`/api/v1/notifications/${inbox.body.data.items[0].id}/read`).set(auth(owner.token));
    assert.equal(others.status, 404, "cannot touch someone else's notification");
    const cleared = await request(app).delete("/api/v1/notifications").set(auth(customer.token));
    assert.equal(cleared.body.data.deleted, 5);
    assert.equal((await request(app).get("/api/v1/notifications").set(auth(customer.token))).body.data.items.length, 0);
    assert.ok((await request(app).get("/api/v1/notifications").set(auth(owner.token))).body.data.items.length > 0, "only my own are cleared");
  });
});
