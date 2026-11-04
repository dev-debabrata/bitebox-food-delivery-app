import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { io as connect } from "socket.io-client";
import { Address } from "../models/address.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { attachRealtime } from "../sockets/index.js";
import { setRealtimeServer } from "../sockets/events.js";
import { buildApp, createAndLogin, registerUser, request, resetDb, seedCatalogFor, setupTestDb, teardownTestDb } from "./helpers.js";

const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe("realtime order events (Socket.IO)", () => {
  let app;
  let server;
  let io;
  let url;
  const sockets = [];

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

  let owner;
  let customer;
  beforeEach(async () => {
    await resetDb();
    owner = await seedCatalogFor(app);
    const { seedCheckoutData } = await import("../scripts/seed.js");
    await seedCheckoutData();
    await Restaurant.updateOne({ slug: "spice-route-kitchen" }, { openingTime: "00:00", closingTime: "00:00" });
    customer = await createAndLogin(app, "customer");
  });

  /** Connects and collects every order:updated event. Resolves once connected (or rejects with the error). */
  function listen(token) {
    const socket = connect(url, { auth: { token }, transports: ["websocket"], reconnection: false });
    sockets.push(socket);
    const events = [];
    socket.on("order:updated", (e) => events.push(e));
    return new Promise((resolve, reject) => {
      socket.on("connect", () => resolve({ socket, events }));
      socket.on("connect_error", reject);
    });
  }
  const settle = () => new Promise((r) => setTimeout(r, 150));

  async function placeOrder() {
    const food = await FoodItem.findOne({ name: "Butter Chicken" });
    await request(app).post("/api/v1/cart/items").set(auth(customer.token)).send({ foodItemId: food.id, quantity: 1 });
    const address = await Address.findOne({ user: customer.user.id });
    const res = await request(app).post("/api/v1/orders").set(auth(customer.token)).send({ addressId: String(address._id), paymentMethod: "cod" });
    return res.body.data.order;
  }

  it("refuses connections without a valid access token", async () => {
    await assert.rejects(listen(undefined), /Authentication required/);
    await assert.rejects(listen("not-a-jwt"), /Invalid access token/);
  });

  it("delivers order events only to the people involved", async () => {
    const restaurantFeed = await listen(owner.token);
    const customerFeed = await listen(customer.token);
    const stranger = await registerUser(app);
    const strangerFeed = await listen(stranger.token);
    const otherOwner = await registerUser(app, { role: "restaurant" });
    const otherRestaurantFeed = await listen(otherOwner.token);

    const order = await placeOrder();
    await settle();
    assert.deepEqual(
      restaurantFeed.events.map((e) => [e.id, e.status]),
      [[order.id, "pending"]],
      "the restaurant hears about its new order",
    );

    await request(app).patch(`/api/v1/my/restaurant/orders/${order.id}/status`).set(auth(owner.token)).send({ status: "confirmed" });
    await settle();
    assert.equal(customerFeed.events.at(-1)?.status, "confirmed", "the customer sees the acceptance live");
    assert.equal(strangerFeed.events.length, 0, "other customers hear nothing");
    assert.equal(otherRestaurantFeed.events.length, 0, "other restaurants hear nothing");
    assert.deepEqual(Object.keys(customerFeed.events[0]).sort(), ["id", "orderNumber", "status", "updatedAt"], "no order details in events");
  });
});
