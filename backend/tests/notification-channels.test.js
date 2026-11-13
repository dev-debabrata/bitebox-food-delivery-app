// Notification channels and background delivery (same contract as backend-django's
// apps/notifications tests): push, email, SMS and FCM per preference, the delivery log with
// retries and dead letters, and the new events (welcome, payment failed, refund started,
// rider approaching). No real provider is ever reached.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { Address } from "../models/address.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { Notification } from "../models/notification.model.js";
import { NotificationDelivery } from "../models/notification-delivery.model.js";
import { Order } from "../models/order.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { User } from "../models/user.model.js";
import { testOutbox } from "../services/mail.service.js";
import { testSmsOutbox, useChannel } from "../services/notification-channels.js";
import { MAX_ATTEMPTS, attempt, notify, retryDue } from "../services/notification.service.js";
import { flushPush, usePushSender } from "../services/push.service.js";
import { onPosition } from "../services/tracking.service.js";
import {
  buildApp,
  createAndLogin,
  registerUser,
  request,
  resetDb,
  seedCatalogFor,
  setupTestDb,
  teardownTestDb,
} from "./helpers.js";

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const SUB = {
  endpoint: `https://fcm.googleapis.com/fcm/send/device-${"x".repeat(40)}`,
  keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) },
};

describe("notification channels and deliveries", () => {
  let app;
  let pushed;

  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(teardownTestDb);
  beforeEach(async () => {
    await resetDb();
    pushed = [];
    testSmsOutbox.length = 0;
    usePushSender(async (sub, payload) => pushed.push(JSON.parse(payload).notification.title));
  });
  afterEach(async () => {
    await flushPush();
    usePushSender(null);
    useChannel("email", null);
    useChannel("smsProvider", null);
  });

  const api = (token) => ({
    get: (url) => request(app).get(url).set(auth(token)),
    put: (url, body) => request(app).put(url).set(auth(token)).send(body),
    post: (url, body = {}) => request(app).post(url).set(auth(token)).send(body),
    del: (url, body) => request(app).delete(url).set(auth(token)).send(body),
  });
  const statuses = async (userId, type) => {
    const n = await Notification.findOne({ user: userId, type });
    const rows = await NotificationDelivery.find({ notification: n._id });
    return Object.fromEntries(rows.map((d) => [d.channel, d.status]));
  };

  it("sends each notification to the channels the person allows", async () => {
    useChannel("smsProvider", "test");
    const { token, res } = await registerUser(app, { name: "Meera Rao" });
    const userId = res.body.data.user.id;
    await flushPush();
    assert.equal((await Notification.findOne({ user: userId, type: "account.welcome" })).title, "Welcome to BiteBox, Meera Rao!");
    assert.ok(testOutbox.some((m) => m.subject === "Welcome to BiteBox, Meera Rao! | BiteBox"), "welcome email");

    await api(token).post("/api/v1/push/subscriptions", SUB);
    await notify(userId, { type: "order.placed", title: "Order BB-1 placed", link: "/orders/1" });
    await flushPush();
    assert.deepEqual(await statuses(userId, "order.placed"), { push: "sent", email: "sent" });
    assert.deepEqual(pushed, ["Order BB-1 placed"]);
    const email = testOutbox.at(-1);
    assert.equal(email.subject, "Order BB-1 placed | BiteBox");
    assert.match(email.text, /http:\/\/localhost:4200\/orders\/1/);

    // SMS is opt-in: turned on for orders, the delivery code goes by SMS too.
    const prefs = await api(token).put("/api/v1/notifications/preferences", { sms: { orders: true } });
    assert.equal(prefs.body.data.channels.sms.orders, true);
    await User.updateOne({ _id: userId }, { phone: "+919000000002" });
    await notify(userId, { type: "order.picked_up", title: "Order picked up", body: "Code 1234" });
    await flushPush();
    assert.deepEqual(testSmsOutbox.at(-1), { to: "+919000000002", text: "BiteBox: Order picked up. Code 1234" });

    // Push off for orders: the inbox row is still written.
    await api(token).put("/api/v1/notifications/preferences", { push: { orders: false } });
    const before = pushed.length;
    await notify(userId, { type: "order.delivered", title: "Delivered" });
    await flushPush();
    assert.equal(pushed.length, before);
    assert.ok(await Notification.exists({ user: userId, type: "order.delivered" }));
    assert.equal((await api(token).put("/api/v1/notifications/preferences", { email: { orders: "no" } })).status, 422);
  });

  it("retries failures with back-off, then keeps a dead letter admins can retry", async () => {
    const { res } = await registerUser(app);
    const userId = res.body.data.user.id;
    await flushPush();
    let calls = 0;
    useChannel("email", async () => {
      calls += 1;
      throw new Error("SMTP timed out");
    });
    await notify(userId, { type: "payment.refunded", title: "Refund processed" });
    await flushPush();
    const n = await Notification.findOne({ user: userId, type: "payment.refunded" });
    let d = await NotificationDelivery.findOne({ notification: n._id, channel: "email" });
    assert.deepEqual([d.status, d.attempts], ["failed", 1]);
    assert.match(d.lastError, /SMTP timed out/);
    assert.equal(await attempt(d._id), null, "not due yet");
    let later = Date.now();
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      later += 2 * 60 * 60_000;
      await attempt(d._id, new Date(later));
    }
    d = await NotificationDelivery.findById(d._id);
    assert.deepEqual([d.status, d.attempts, d.nextAttemptAt], ["dead", MAX_ATTEMPTS, null]);
    assert.equal(calls, MAX_ATTEMPTS);

    useChannel("email", null);
    const ops = await createAndLogin(app, "operations_admin");
    const log = (await api(ops.token).get("/api/v1/admin/notifications/deliveries?status=dead")).body.data;
    assert.deepEqual(log.items.map((i) => i.id), [String(d._id)]);
    assert.equal(log.counts.dead, 1);
    const retried = await api(ops.token).post(`/api/v1/admin/notifications/deliveries/${d._id}/retry`);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.data.delivery.status, "sent");
    assert.equal((await api(ops.token).post(`/api/v1/admin/notifications/deliveries/${d._id}/retry`)).status, 409);
    const customer = await createAndLogin(app, "customer");
    assert.equal((await api(customer.token).get("/api/v1/admin/notifications/deliveries")).status, 403);
  });

  it("requeues deliveries nobody picked up", async () => {
    const { res } = await registerUser(app);
    await flushPush();
    const n = await Notification.create({ user: res.body.data.user.id, type: "order.delivered", title: "Delivered" });
    await NotificationDelivery.create({ notification: n._id, user: n.user, channel: "email" });
    assert.equal((await retryDue(new Date())).retried, 0, "just created");
    assert.equal((await retryDue(new Date(Date.now() + 3 * 60_000))).retried, 1);
    assert.equal((await NotificationDelivery.findOne({ notification: n._id })).status, "sent");
  });

  it("shows which channels are available and registers app devices", async () => {
    const { token } = await registerUser(app);
    const data = (await api(token).get("/api/v1/notifications/preferences")).body.data;
    assert.deepEqual(data.channels.email, { orders: true, account: true, promotions: false });
    assert.deepEqual(data.channels.sms, { orders: false, account: false, promotions: false });
    assert.deepEqual(data.available, { push: true, email: true, sms: false });
    const token2 = `fcm-token-${"x".repeat(40)}`;
    assert.equal((await api(token).post("/api/v1/push/devices", { token: token2, platform: "android" })).status, 201);
    assert.deepEqual((await api(token).del("/api/v1/push/devices", { token: token2 })).body.data, { removed: true });
  });

  it("tells the customer about a failed payment, a refund starting and the rider approaching", async () => {
    const owner = await seedCatalogFor(app);
    const { seedCheckoutData } = await import("../scripts/seed.js");
    await seedCheckoutData();
    await Restaurant.updateOne({ slug: "spice-route-kitchen" }, { openingTime: "00:00", closingTime: "00:00" });
    const customer = await createAndLogin(app, "customer");
    const food = await FoodItem.findOne({ name: "Butter Chicken" });
    const address = await Address.findOne({ user: customer.user.id, isDefault: true });
    const place = async (paymentMethod) => {
      await api(customer.token).post("/api/v1/cart/items", { foodItemId: food.id, quantity: 2 });
      const res = await api(customer.token).post("/api/v1/orders", { addressId: String(address._id), paymentMethod });
      return res.body.data.order.id;
    };
    const online = await place("online");
    await api(customer.token).post(`/api/v1/payments/orders/${online}/mock`, { outcome: "failure" });
    assert.ok(await Notification.exists({ user: customer.user.id, type: "payment.failed" }));
    await api(customer.token).post(`/api/v1/payments/orders/${online}/mock`, { outcome: "success" });
    await request(app)
      .patch(`/api/v1/my/restaurant/orders/${online}/status`)
      .set(auth(owner.token))
      .send({ status: "rejected", reason: "Closed early" });
    const started = await Notification.findOne({ user: customer.user.id, type: "payment.refund_started" });
    assert.match(started.title, /^Refund of ₹/);

    const cash = await place("cod");
    await Order.updateOne({ _id: cash }, { status: "on_the_way", deliveryOtp: "4821" });
    const rider = (await createAndLogin(app, "delivery")).user.id;
    await onPosition(rider, cash, { latitude: 12.96, longitude: 77.635 }, new Date()); // ~3 km away
    assert.equal(await Notification.countDocuments({ type: "order.approaching" }), 0);
    await onPosition(rider, cash, { latitude: 12.937, longitude: 77.628 }, new Date()); // ~220 m
    await onPosition(rider, cash, { latitude: 12.936, longitude: 77.6275 }, new Date());
    const notes = await Notification.find({ user: customer.user.id, type: "order.approaching" });
    assert.equal(notes.length, 1, "told once");
    assert.match(notes[0].body, /4821/);
  });
});
