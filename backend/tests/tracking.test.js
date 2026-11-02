import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { io as connect } from "socket.io-client";
import { Address } from "../src/models/address.model.js";
import { DeliveryPartner } from "../src/models/delivery-partner.model.js";
import { FoodItem } from "../src/models/food-item.model.js";
import { Restaurant } from "../src/models/restaurant.model.js";
import { useProvider } from "../src/services/routing.service.js";
import { setRealtimeServer } from "../src/sockets/events.js";
import { attachRealtime } from "../src/sockets/index.js";
import { buildApp, createAndLogin, registerUser, request, resetDb, seedCatalogFor, setupTestDb, teardownTestDb } from "./helpers.js";

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const NEAR = { latitude: 12.9729, longitude: 77.6412 }; // next to the seeded restaurant
const settle = () => new Promise((r) => setTimeout(r, 150));

describe("live tracking and routing", () => {
  let app;
  let server;
  let io;
  let url;
  const sockets = [];
  let owner;
  let customer;
  let rider;

  before(async () => {
    await setupTestDb();
    app = buildApp();
    server = http.createServer(app);
    io = attachRealtime(server);
    await new Promise((resolve) => server.listen(0, resolve));
    url = `http://localhost:${server.address().port}`;
  });
  after(async () => {
    sockets.forEach((s) => s.close());
    io.close();
    setRealtimeServer(null);
    await teardownTestDb();
  });

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

  function open(token) {
    const socket = connect(url, { auth: { token }, transports: ["websocket"], reconnection: false });
    sockets.push(socket);
    const locations = [];
    socket.on("order:location", (e) => locations.push(e));
    const emit = (event, body) => socket.timeout(2000).emitWithAck(event, body);
    return new Promise((resolve, reject) => {
      socket.on("connect", () => resolve({ socket, locations, emit }));
      socket.on("connect_error", reject);
    });
  }

  /** An order assigned to the seeded rider (who is online next to the restaurant). */
  async function assignedOrder() {
    const food = await FoodItem.findOne({ name: "Butter Chicken" });
    await request(app).post("/api/v1/cart/items").set(auth(customer.token)).send({ foodItemId: food.id, quantity: 2 });
    const address = await Address.findOne({ user: customer.user.id });
    const placed = await request(app).post("/api/v1/orders").set(auth(customer.token)).send({ addressId: String(address._id), paymentMethod: "cod" });
    const id = placed.body.data.order.id;
    for (const status of ["confirmed", "preparing", "ready_for_pickup"]) {
      await request(app).patch(`/api/v1/my/restaurant/orders/${id}/status`).set(auth(owner.token)).send({ status });
    }
    await request(app).patch("/api/v1/delivery/me/availability").set(auth(rider.token)).send({ isOnline: true, ...NEAR });
    const accepted = await request(app).post(`/api/v1/delivery/offers/${id}/accept`).set(auth(rider.token));
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    return id;
  }

  it("lets only people involved in the order watch it, starting from the last known position", async () => {
    const id = await assignedOrder();
    const viewer = await open(customer.token);
    const joined = await viewer.emit("track:join", { orderId: id });
    assert.equal(joined.ok, true);
    assert.equal(joined.location.latitude, NEAR.latitude, "last position from going online");
    assert.ok(joined.location.at, "with its time, so the app can tell if it is stale");

    const stranger = await open((await registerUser(app)).token);
    assert.deepEqual(await stranger.emit("track:join", { orderId: id }), { ok: false, error: "NOT_FOUND" });
    assert.deepEqual(await stranger.emit("track:join", { orderId: "not-an-id" }), { ok: false, error: "INVALID_ORDER" });
    const restaurantViewer = await open(owner.token);
    assert.equal((await restaurantViewer.emit("track:join", { orderId: id })).ok, true, "the restaurant may watch its own order");
  });

  it("streams the rider's position to the order's viewers only", async () => {
    const id = await assignedOrder();
    const viewer = await open(customer.token);
    await viewer.emit("track:join", { orderId: id });
    const bystander = await open((await registerUser(app)).token);
    const riderSocket = await open(rider.token);

    const moved = { latitude: 12.9735, longitude: 77.642, accuracy: 12 };
    assert.deepEqual(await riderSocket.emit("rider:location", moved), { ok: true });
    await settle();
    assert.equal(viewer.locations.length, 1);
    assert.equal(viewer.locations[0].orderId, id);
    assert.equal(viewer.locations[0].latitude, moved.latitude);
    assert.equal(bystander.locations.length, 0);
    const saved = await DeliveryPartner.findOne({ user: rider.user.id });
    assert.deepEqual(saved.location.coordinates, [moved.longitude, moved.latitude], "persisted for dispatch and late joiners");
  });

  it("rejects bad, imprecise, impossible and too-frequent updates, and non-riders", async () => {
    await assignedOrder();
    const riderSocket = await open(rider.token);
    assert.equal((await riderSocket.emit("rider:location", { latitude: 200, longitude: 0 })).error, "INVALID_LOCATION");
    assert.equal((await riderSocket.emit("rider:location", { latitude: "x", longitude: 1 })).error, "INVALID_LOCATION");
    assert.equal((await riderSocket.emit("rider:location", { ...NEAR, accuracy: 5000 })).error, "IMPRECISE");
    assert.equal((await riderSocket.emit("rider:location", NEAR)).ok, true);
    // 50 km away a second later: not a real journey.
    assert.equal((await riderSocket.emit("rider:location", { latitude: 13.42, longitude: 77.64 })).error, "IMPLAUSIBLE");

    const results = [];
    for (let i = 0; i < 6; i++) results.push((await riderSocket.emit("rider:location", NEAR)).error);
    assert.ok(results.includes("RATE_LIMITED"), "bursts beyond the bucket are refused");

    const customerSocket = await open(customer.token);
    // Customers have no rider:location handler at all: the request just times out.
    await assert.rejects(customerSocket.socket.timeout(300).emitWithAck("rider:location", NEAR), "customers cannot send rider positions");
  });

  it("stops sharing the rider's position once the order is delivered", async () => {
    const id = await assignedOrder();
    const viewer = await open(customer.token);
    await viewer.emit("track:join", { orderId: id });
    for (const status of ["picked_up", "on_the_way", "delivered"]) {
      await request(app).patch(`/api/v1/delivery/orders/${id}/status`).set(auth(rider.token)).send({ status });
    }
    await settle();
    const riderSocket = await open(rider.token);
    await riderSocket.emit("rider:location", NEAR);
    await settle();
    assert.equal(viewer.locations.length, 0);
    const late = await viewer.emit("track:join", { orderId: id });
    assert.deepEqual(late, { ok: true, location: null, tracking: false });
  });

  describe("road routes", () => {
    const from = "fromLat=12.9719&fromLng=77.6412";
    const to = "toLat=12.9352&toLng=77.6271";

    it("returns distance, duration and path, cached, behind sign-in", async () => {
      let calls = 0;
      const restore = useProvider({
        name: "fake",
        attribution: "test",
        route: async (a, b) => {
          calls++;
          return { distanceMeters: 5200, durationSeconds: 780, path: [a, b] };
        },
      });
      try {
        assert.equal((await request(app).get(`/api/v1/geo/route?${from}&${to}`)).status, 401);
        const res = await request(app).get(`/api/v1/geo/route?${from}&${to}`).set(auth(customer.token));
        assert.equal(res.status, 200);
        const r = res.body.data.route;
        assert.equal(r.distanceMeters, 5200);
        assert.equal(r.durationSeconds, 780);
        assert.equal(r.estimate, true);
        assert.ok(r.straightLineMeters > 3000 && r.straightLineMeters < r.distanceMeters, "straight line reported separately");
        await request(app).get(`/api/v1/geo/route?${from}&${to}`).set(auth(customer.token));
        assert.equal(calls, 1, "second request served from cache");
      } finally {
        restore();
      }
    });

    it("answers 503 when the provider fails, and refuses silly distances", async () => {
      const restore = useProvider({ name: "down", attribution: "", route: async () => Promise.reject(new Error("boom")) });
      try {
        const res = await request(app).get(`/api/v1/geo/route?${from}&${to}`).set(auth(customer.token));
        assert.equal(res.status, 503);
        assert.equal(res.body.error.code, "ROUTING_UNAVAILABLE");
        const far = await request(app).get(`/api/v1/geo/route?${from}&toLat=19.07&toLng=72.87`).set(auth(customer.token));
        assert.equal(far.status, 400);
        const bad = await request(app).get(`/api/v1/geo/route?fromLat=500&fromLng=1&${to}`).set(auth(customer.token));
        assert.equal(bad.status, 422);
      } finally {
        restore();
      }
    });
  });
});
