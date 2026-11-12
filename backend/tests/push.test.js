import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { PushSubscription } from "../models/push-subscription.model.js";
import { User } from "../models/user.model.js";
import { notify } from "../services/notification.service.js";
import {
  categoryOf,
  flushPush,
  isAllowedEndpoint,
  usePushSender,
} from "../services/push.service.js";
import {
  buildApp,
  createAndLogin,
  registerUser,
  request,
  resetDb,
  setupTestDb,
  teardownTestDb,
} from "./helpers.js";

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const P256DH = "B".repeat(87);
const AUTH = "a".repeat(22);
const sub = (id = "device-one", host = "fcm.googleapis.com") => ({
  endpoint: `https://${host}/fcm/send/${id}-${"x".repeat(40)}`,
  expirationTime: null,
  keys: { p256dh: P256DH, auth: AUTH },
});

describe("web push", () => {
  let app;
  let sent;
  let failWith; // endpoint -> HTTP status the fake push service answers with

  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(teardownTestDb);
  beforeEach(async () => {
    await resetDb();
    sent = [];
    failWith = new Map();
    usePushSender(async (subscription, payload, options) => {
      const status = failWith.get(subscription.endpoint);
      if (status) throw Object.assign(new Error("push failed"), { statusCode: status });
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options });
    });
  });
  afterEach(async () => {
    await flushPush();
    usePushSender(null);
  });

  const customer = async () => registerUser(app, { name: "Tara Bloom" });
  const subscribe = (token, body = sub()) =>
    request(app)
      .post("/api/v1/push/subscriptions")
      .set(auth(token))
      .set("User-Agent", "Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36")
      .send(body);

  it("exposes only the public key, and reports push as off without one", async () => {
    const res = await request(app).get("/api/v1/push/public-key");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { enabled: true, publicKey: "test-vapid-public-key" });

    usePushSender(null);
    const off = await request(app).get("/api/v1/push/public-key");
    assert.deepEqual(off.body.data, { enabled: false, publicKey: null });
    const { token } = await customer();
    assert.equal((await subscribe(token)).status, 503, "cannot subscribe while push is off");
  });

  it("stores a subscription once, never returns its keys, and needs sign-in", async () => {
    assert.equal((await request(app).post("/api/v1/push/subscriptions").send(sub())).status, 401);
    const { token, res: reg } = await customer();
    const first = await subscribe(token);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.subscription.device, "Chrome on Android");
    assert.equal(first.body.data.subscription.keys, undefined, "keys are never sent back");
    assert.equal((await subscribe(token)).status, 201, "repeating is harmless");
    assert.equal(await PushSubscription.countDocuments(), 1);
    const row = await PushSubscription.findOne();
    assert.equal(String(row.user), reg.body.data.user.id);
  });

  it("refuses endpoints that are not a known push service (SSRF guard) and bad keys", async () => {
    const { token } = await customer();
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/abcdefghijklmnopqrstuvwxyz",
      "https://169.254.169.254/latest/meta-data/abcdefghijk",
      "https://evil.example.com/fcm/send/abcdefghijklmnopqrstu",
      "https://fcm.googleapis.com.evil.example.com/abcdefghijklmn",
      "https://fcm.googleapis.com:8443/fcm/send/abcdefghijklmnopq",
    ]) {
      const res = await subscribe(token, { ...sub(), endpoint });
      assert.equal(res.status, 422, endpoint);
    }
    assert.equal((await subscribe(token, { ...sub(), keys: { p256dh: "short", auth: AUTH } })).status, 422);
    assert.equal((await subscribe(token, { ...sub(), keys: { p256dh: P256DH } })).status, 422);
    assert.equal(await PushSubscription.countDocuments(), 0);

    assert.equal(isAllowedEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc"), true);
    assert.equal(isAllowedEndpoint("https://web.push.apple.com/QGx"), true);
    assert.equal(isAllowedEndpoint("https://wns2-par02p.notify.windows.com/w/?token=abc"), true);
  });

  it("moves a browser to whoever subscribes from it next, and only the owner can remove it", async () => {
    const a = await customer();
    const b = await registerUser(app, { name: "Ravi Lantern" });
    await subscribe(a.token);
    await subscribe(b.token);
    assert.equal(await PushSubscription.countDocuments(), 1);
    assert.equal(String((await PushSubscription.findOne()).user), b.res.body.data.user.id);

    const notMine = await request(app)
      .delete("/api/v1/push/subscriptions")
      .set(auth(a.token))
      .send({ endpoint: sub().endpoint });
    assert.equal(notMine.body.data.removed, false);
    const mine = await request(app)
      .delete("/api/v1/push/subscriptions")
      .set(auth(b.token))
      .send({ endpoint: sub().endpoint });
    assert.equal(mine.body.data.removed, true);
    assert.equal(await PushSubscription.countDocuments(), 0);
  });

  it("pushes every in-app notification in the Angular service worker format", async () => {
    const { token, res } = await customer();
    await subscribe(token);
    const orderId = "64b7f0c2a1b2c3d4e5f60718";
    await notify(res.body.data.user.id, {
      type: "order.preparing",
      title: "Order BB-1001 is being prepared",
      body: "Green Fork Kitchen has started cooking your food.",
      link: `/orders/${orderId}`,
      order: orderId,
    });
    await flushPush();
    assert.equal(sent.length, 1);
    const { notification } = sent[0].payload;
    assert.equal(notification.title, "Order BB-1001 is being prepared");
    assert.equal(notification.tag, `order-${orderId}`);
    assert.deepEqual(notification.data.onActionClick.default, {
      operation: "navigateLastFocusedOrOpen",
      url: `/orders/${orderId}`,
    });
    assert.equal(sent[0].options.urgency, "high");
    assert.equal(sent[0].options.topic, `o${orderId}`);
  });

  it("only opens same-site links from a notification", async () => {
    const { token, res } = await customer();
    await subscribe(token);
    await notify(res.body.data.user.id, { type: "support.reply", title: "Reply", link: "//evil.example.com" });
    await flushPush();
    assert.equal(sent[0].payload.notification.data.url, "/");
  });

  it("respects preferences and skips suspended accounts", async () => {
    const { token, res } = await customer();
    const userId = res.body.data.user.id;
    await subscribe(token);

    const prefs = await request(app).get("/api/v1/push/preferences").set(auth(token));
    assert.deepEqual(prefs.body.data.preferences, { orders: true, account: true, promotions: false });
    assert.deepEqual(prefs.body.data.categories, ["orders", "account", "promotions"]);
    assert.equal(prefs.body.data.devices, 1);

    const bad = await request(app).put("/api/v1/push/preferences").set(auth(token)).send({ orders: "nope" });
    assert.equal(bad.status, 422);
    const off = await request(app)
      .put("/api/v1/push/preferences")
      .set(auth(token))
      .send({ orders: false, unknown: true });
    assert.equal(off.status, 200);
    assert.equal(off.body.data.preferences.orders, false);
    assert.equal(off.body.data.preferences.account, true, "untouched switches keep their value");

    await notify(userId, { type: "order.confirmed", title: "Accepted" });
    await notify(userId, { type: "coins.earned", title: "Coins" });
    await flushPush();
    assert.deepEqual(sent.map((s) => s.payload.notification.title), ["Coins"]);

    await User.updateOne({ _id: userId }, { status: "suspended" });
    await notify(userId, { type: "coins.earned", title: "Coins again" });
    await flushPush();
    assert.equal(sent.length, 1, "suspended accounts get nothing");
    assert.equal(categoryOf("payment.refunded"), "orders");
    assert.equal(categoryOf("promo.offer"), "promotions");
  });

  it("removes expired subscriptions (404/410) and gives up on ones that keep failing", async () => {
    const { token, res } = await customer();
    const userId = res.body.data.user.id;
    const gone = sub("gone");
    const flaky = sub("flaky");
    await subscribe(token, gone);
    await subscribe(token, flaky);
    failWith.set(gone.endpoint, 410);
    failWith.set(flaky.endpoint, 500);

    await notify(userId, { type: "coins.earned", title: "One" });
    await flushPush();
    assert.equal(await PushSubscription.countDocuments({ endpoint: gone.endpoint }), 0);
    assert.equal((await PushSubscription.findOne({ endpoint: flaky.endpoint })).failures, 1);

    for (let i = 0; i < 4; i++) {
      await notify(userId, { type: "coins.earned", title: `Try ${i}` });
      await flushPush();
    }
    assert.equal(await PushSubscription.countDocuments(), 0, "dropped after five failures in a row");
  });

  it("sends promotions only to customers who opted in, with permission and an audit entry", async () => {
    const admin = await createAndLogin(app, "admin");
    const ops = await createAndLogin(app, "operations_admin");
    const keen = await customer();
    const quiet = await registerUser(app, { name: "Mina Harbor" });
    await subscribe(keen.token, sub("keen"));
    await subscribe(quiet.token, sub("quiet"));
    await request(app).put("/api/v1/push/preferences").set(auth(keen.token)).send({ promotions: true });

    const offer = { title: "Weekend treat", body: "Free dessert on orders above ₹400.", link: "/restaurants" };
    assert.equal(
      (await request(app).post("/api/v1/admin/push/promotions").set(auth(ops.token)).send(offer)).status,
      403,
    );
    assert.equal(
      (await request(app).post("/api/v1/admin/push/promotions").set(auth(keen.token)).send(offer)).status,
      403,
    );
    const badLink = await request(app)
      .post("/api/v1/admin/push/promotions")
      .set(auth(admin.token))
      .send({ ...offer, link: "https://evil.example.com" });
    assert.equal(badLink.status, 422);

    const res = await request(app).post("/api/v1/admin/push/promotions").set(auth(admin.token)).send(offer);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.recipients, 1);
    await flushPush();
    assert.deepEqual(sent.map((s) => s.endpoint), [sub("keen").endpoint]);
    assert.equal(sent[0].payload.notification.data.url, "/restaurants");

    const { AuditLog } = await import("../models/audit-log.model.js");
    await new Promise((r) => setImmediate(r));
    assert.equal(await AuditLog.countDocuments({ action: "push.promotion" }), 1);
  });

  it("does nothing (and touches no data) when push is not configured", async () => {
    usePushSender(null);
    const { res } = await customer();
    await notify(res.body.data.user.id, { type: "coins.earned", title: "Coins" });
    await flushPush();
    assert.equal(sent.length, 0);
  });
});
