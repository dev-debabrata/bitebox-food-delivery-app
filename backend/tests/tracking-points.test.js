// Maps and tracking (same contract as backend-django's apps/tracking tests): tracking points
// (sampled, only while carrying an order, expired by a TTL index), GET /tracking/orders/:id and
// the arrival distance check.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { env } from "../config/env.js";
import { Address } from "../models/address.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { TrackingPoint } from "../models/tracking-point.model.js";
import { orderTracking, record } from "../services/tracking.service.js";
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
const NEAR = { latitude: 12.9729, longitude: 77.6412 }; // ~110 m from the restaurant
const FARTHER = { latitude: 12.9899, longitude: 77.6412 }; // ~2 km

describe("delivery tracking: trail, tracking view, arrival distance", () => {
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
    put: (url, body) => request(app).put(url).set(auth(token)).send(body),
    patch: (url, body) => request(app).patch(url).set(auth(token)).send(body),
  });
  const goOnline = (token, where = NEAR) =>
    api(token).patch("/api/v1/delivery/me/availability", { isOnline: true, ...where });
  const move = (token, where) => api(token).put("/api/v1/delivery/me/location", where);
  const track = (token, id) => api(token).get(`/api/v1/tracking/orders/${id}`);
  const riderSet = async (token, id, status) =>
    api(token).patch(`/api/v1/delivery/orders/${id}/status`, await riderStatusBody(id, status));

  async function readyOrder() {
    await api(customer.token).post("/api/v1/cart/items", {
      foodItemId: food["Butter Chicken"].id,
      quantity: 2,
    });
    const address = await Address.findOne({ user: customer.user.id, isDefault: true });
    const res = await api(customer.token).post("/api/v1/orders", {
      addressId: String(address._id),
      paymentMethod: "cod",
    });
    const id = res.body.data.order.id;
    for (const status of ["confirmed", "preparing", "ready_for_pickup"])
      await api(owner.token).patch(`/api/v1/my/restaurant/orders/${id}/status`, { status });
    return id;
  }
  async function assigned() {
    await goOnline(rider.token);
    const id = await readyOrder();
    assert.equal((await api(rider.token).post(`/api/v1/delivery/offers/${id}/accept`)).status, 200);
    return id;
  }

  it("keeps points only while carrying an order, sampled", async () => {
    await goOnline(rider.token);
    assert.equal((await move(rider.token, NEAR)).status, 200);
    assert.equal(await TrackingPoint.countDocuments(), 0, "just online: no trail kept");

    const id = await assigned();
    await move(rider.token, NEAR);
    await move(rider.token, FARTHER); // within the sample interval: not stored
    assert.equal(await TrackingPoint.countDocuments({ order: id }), 1);
    const later = new Date(Date.now() + 20_000);
    assert.equal(await record(rider.user.id, id, FARTHER, later), true);
    assert.equal(await TrackingPoint.countDocuments({ order: id }), 2);
  });

  it("restores the map over REST, for the customer, rider and staff only", async () => {
    const id = await assigned();
    await move(rider.token, NEAR);
    const res = await track(customer.token, id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body.data;
    assert.equal(d.tracking, true);
    assert.equal(d.status, "assigned");
    assert.equal(d.lastPoint.latitude, NEAR.latitude);
    assert.equal(d.stale, false);
    assert.ok(d.ageSeconds <= 5);
    assert.deepEqual(d.recentPath, [[NEAR.latitude, NEAR.longitude]]);

    const user = { _id: customer.user.id, role: "customer" };
    const later = await orderTracking(user, id, new Date(Date.now() + 3 * 60_000));
    assert.equal(later.stale, true, "an old position is stale");

    assert.equal((await track(rider.token, id)).status, 200);
    const ops = await createAndLogin(app, "operations_admin");
    assert.equal((await track(ops.token, id)).status, 200);
    const stranger = await registerUser(app);
    assert.equal((await track(stranger.token, id)).status, 404);
    assert.equal((await track(owner.token, id)).status, 404);
    assert.equal((await request(app).get(`/api/v1/tracking/orders/${id}`)).status, 401);
  });

  it("has nothing to track before assignment or after delivery", async () => {
    const id = await assigned();
    await move(rider.token, NEAR);
    for (const status of ["picked_up", "on_the_way", "delivered"])
      assert.equal((await riderSet(rider.token, id, status)).status, 200);
    const done = (await track(customer.token, id)).body.data;
    assert.deepEqual([done.tracking, done.lastPoint, done.recentPath], [false, null, []]);
    assert.ok(await TrackingPoint.exists({ order: id }), "kept until it expires");
  });

  it("expires points after the retention period (TTL index)", async () => {
    const indexes = await TrackingPoint.collection.indexes();
    const ttl = indexes.find((i) => i.key.recordedAt === 1 && "expireAfterSeconds" in i);
    assert.equal(ttl?.expireAfterSeconds, env.tracking.retentionDays * 86_400);
  });

  it("flags arrivals far from the restaurant for admins", async () => {
    const id = await assigned(); // ~110 m away
    await riderSet(rider.token, id, "arrived_at_restaurant");
    const admin = await createAndLogin(app, "admin");
    const near = (await api(admin.token).get(`/api/v1/admin/orders/${id}`)).body.data.order;
    assert.ok(near.arrivalDistanceMeters > 50 && near.arrivalDistanceMeters < 200);
    assert.equal(near.arrivedFar, false);
    const mine = (await api(customer.token).get(`/api/v1/orders/${id}`)).body.data.order;
    assert.equal(mine.arrivalDistanceMeters, undefined, "admins only");

    const { token: far } = await registerUser(app, { role: "delivery", name: "Far Rider" });
    await api(far).put("/api/v1/delivery/me/vehicle", {
      vehicleType: "scooter",
      vehicleNumber: "KA 02 CC 1234",
    });
    await goOnline(far, FARTHER);
    const other = await readyOrder(); // the first rider is busy: offered to the far one
    assert.equal((await api(far).post(`/api/v1/delivery/offers/${other}/accept`)).status, 200);
    await riderSet(far, other, "arrived_at_restaurant");
    const flagged = (await api(admin.token).get(`/api/v1/admin/orders/${other}`)).body.data.order;
    assert.ok(flagged.arrivalDistanceMeters > 1500);
    assert.equal(flagged.arrivedFar, true);
  });
});
