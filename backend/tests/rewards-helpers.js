import assert from "node:assert/strict";
import { Address } from "../models/address.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { createAndLogin, request, seedCatalogFor, riderStatusBody } from "./helpers.js";

export const auth = (token) => ({ Authorization: `Bearer ${token}` });
export const NEAR = { latitude: 12.9729, longitude: 77.6412 };

/**
 * Seeds the catalogue, the sample customer (with an address), a restaurant owner and a rider,
 * and returns helpers that drive orders through the real API.
 * Two Butter Chicken = ₹698 subtotal.
 */
export async function orderWorld(app) {
  const owner = await seedCatalogFor(app);
  const { seedCheckoutData, seedDeliveryData } = await import("../scripts/seed.js");
  await seedCheckoutData();
  await seedDeliveryData();
  await Restaurant.updateOne(
    { slug: "spice-route-kitchen" },
    { openingTime: "00:00", closingTime: "00:00" },
  );
  const customer = await createAndLogin(app, "customer");
  const rider = await createAndLogin(app, "delivery");
  const admin = await createAndLogin(app, "admin");

  const api = (token) => ({
    get: (url) => request(app).get(url).set(auth(token)),
    post: (url, body = {}) => request(app).post(url).set(auth(token)).send(body),
    put: (url, body = {}) => request(app).put(url).set(auth(token)).send(body),
    patch: (url, body = {}) => request(app).patch(url).set(auth(token)).send(body),
    del: (url) => request(app).delete(url).set(auth(token)),
  });

  async function fillCart({ token = customer.token, quantity = 2 } = {}) {
    const food = await FoodItem.findOne({ name: "Butter Chicken" });
    const res = await api(token).post("/api/v1/cart/items", { foodItemId: food.id, quantity });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data;
  }

  async function addressOf(userId, coordinates = [77.6412, 12.9729]) {
    let address = await Address.findOne({ user: userId });
    if (!address) {
      address = await Address.create({
        user: userId,
        label: "home",
        recipientName: "Test Customer",
        phone: "9000000099",
        line1: "12 Sample Street",
        area: "Koramangala",
        city: "Bengaluru",
        state: "Karnataka",
        postalCode: "560034",
        location: { type: "Point", coordinates },
        isDefault: true,
      });
    }
    return address;
  }

  /** Places the current cart. Returns { order, checkout } or the raw response with { raw: true }. */
  async function place(paymentMethod = "cod", { token = customer.token, userId = customer.user.id, expectStatus = 201, body = {}, coordinates } = {}) {
    const address = await addressOf(userId, coordinates);
    const res = await api(token).post("/api/v1/orders", {
      addressId: String(address._id),
      paymentMethod,
      ...body,
    });
    assert.equal(res.status, expectStatus, JSON.stringify(res.body));
    return res.body.data ?? res.body;
  }

  const mockPay = (orderId, outcome, token = customer.token) =>
    api(token).post(`/api/v1/payments/orders/${orderId}/mock`, { outcome });

  async function toReady(orderId) {
    for (const status of ["confirmed", "preparing", "ready_for_pickup"]) {
      const res = await api(owner.token).patch(`/api/v1/my/restaurant/orders/${orderId}/status`, { status });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
  }

  async function deliver(orderId) {
    await toReady(orderId);
    await api(rider.token).patch("/api/v1/delivery/me/availability", { isOnline: true, ...NEAR });
    const accept = await api(rider.token).post(`/api/v1/delivery/offers/${orderId}/accept`);
    assert.equal(accept.status, 200, JSON.stringify(accept.body));
    for (const status of ["picked_up", "on_the_way", "delivered"]) {
      const res = await api(rider.token).patch(
        `/api/v1/delivery/orders/${orderId}/status`,
        await riderStatusBody(orderId, status),
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
  }

  const reject = (orderId) =>
    api(owner.token).patch(`/api/v1/my/restaurant/orders/${orderId}/status`, {
      status: "rejected",
      reason: "Kitchen closed early",
    });

  return { owner, customer, rider, admin, api, fillCart, place, mockPay, deliver, toReady, reject, addressOf };
}
