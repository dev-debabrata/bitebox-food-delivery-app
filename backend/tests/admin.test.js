import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Address } from "../models/address.model.js";
import { CouponRedemption } from "../models/coupon.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { Order, Payment } from "../models/order.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { buildApp, createAndLogin, registerUser, request, resetDb, seedCatalogFor, setupTestDb, teardownTestDb } from "./helpers.js";

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const ADDRESS = {
  recipientName: "Asha",
  phone: "9000000002",
  line1: "Flat 4B, 80 Feet Road",
  city: "Bengaluru",
  state: "Karnataka",
  postalCode: "560034",
  location: { latitude: 12.9352, longitude: 77.6271 },
};
const day = 86_400_000;
const coupon = (overrides = {}) => ({
  code: "SPRING25",
  discountType: "percent",
  discountValue: 25,
  maxDiscountPaise: 15000,
  validFrom: new Date(Date.now() - day).toISOString(),
  validUntil: new Date(Date.now() + 30 * day).toISOString(),
  ...overrides,
});

describe("admin coupons, saved addresses and payment administration", () => {
  let app;
  let admin;
  let customer;

  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(teardownTestDb);

  beforeEach(async () => {
    await resetDb();
    admin = await createAndLogin(app, "admin");
    customer = await createAndLogin(app, "customer");
  });

  describe("admin coupons", () => {
    const coupons = (token = admin.token) => request(app).get("/api/v1/admin/coupons").set(auth(token));

    it("creates, lists, searches, updates and deletes coupons", async () => {
      const created = await request(app).post("/api/v1/admin/coupons").set(auth(admin.token)).send(coupon({ code: "spring25" }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const { id, code } = created.body.data.coupon;
      assert.equal(code, "SPRING25", "codes are stored upper-case");

      await request(app).post("/api/v1/admin/coupons").set(auth(admin.token)).send(coupon({ code: "FLAT50", discountType: "flat", discountValue: 5000 }));
      assert.equal((await coupons()).body.data.items.length, 2);
      const found = await request(app).get("/api/v1/admin/coupons?search=spring").set(auth(admin.token));
      assert.deepEqual(found.body.data.items.map((c) => c.code), ["SPRING25"]);

      const updated = await request(app).patch(`/api/v1/admin/coupons/${id}`).set(auth(admin.token)).send({ isActive: false, maxDiscountPaise: null });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.data.coupon.isActive, false);
      assert.equal(updated.body.data.coupon.maxDiscountPaise, null, "null removes the cap");
      const inactive = await request(app).get("/api/v1/admin/coupons?active=false").set(auth(admin.token));
      assert.deepEqual(inactive.body.data.items.map((c) => c.code), ["SPRING25"]);

      assert.equal((await request(app).delete(`/api/v1/admin/coupons/${id}`).set(auth(admin.token))).status, 200);
      assert.equal((await request(app).delete(`/api/v1/admin/coupons/${id}`).set(auth(admin.token))).status, 404);
    });

    it("validates coupons and refuses duplicate codes", async () => {
      const bad = await request(app).post("/api/v1/admin/coupons").set(auth(admin.token)).send(coupon({ code: "x", discountValue: 0 }));
      assert.equal(bad.status, 422);
      const fields = bad.body.error.details.map((d) => d.field);
      assert.ok(fields.includes("code") && fields.includes("discountValue"), fields.join());
      await request(app).post("/api/v1/admin/coupons").set(auth(admin.token)).send(coupon());
      assert.equal((await request(app).post("/api/v1/admin/coupons").set(auth(admin.token)).send(coupon())).status, 409);
    });

    it("keeps used coupons (deactivate instead of delete)", async () => {
      const { id } = (await request(app).post("/api/v1/admin/coupons").set(auth(admin.token)).send(coupon())).body.data.coupon;
      await CouponRedemption.create({ coupon: id, user: customer.user.id, order: "64b7f0c2a1b2c3d4e5f60718", discountPaise: 5000 });
      assert.equal((await request(app).delete(`/api/v1/admin/coupons/${id}`).set(auth(admin.token))).status, 409);
    });

    it("is for admins only", async () => {
      assert.equal((await coupons(customer.token)).status, 403);
      const owner = await createAndLogin(app, "restaurant");
      assert.equal((await request(app).post("/api/v1/admin/coupons").set(auth(owner.token)).send(coupon())).status, 403);
      assert.equal((await request(app).get("/api/v1/admin/coupons")).status, 401);
    });
  });

  describe("saved addresses", () => {
    const create = (token, body = ADDRESS) => request(app).post("/api/v1/addresses").set(auth(token)).send(body);

    it("edits, switches the default and deletes the customer's own addresses", async () => {
      const home = (await create(customer.token)).body.data.address;
      assert.equal(home.isDefault, true, "the first address becomes the default");
      const work = (await create(customer.token, { ...ADDRESS, label: "work", line1: "12 Office Park" })).body.data.address;
      assert.equal(work.isDefault, false);

      const edited = await request(app).patch(`/api/v1/addresses/${work.id}`).set(auth(customer.token)).send({ landmark: "Opposite the bakery" });
      assert.equal(edited.status, 200);
      assert.equal(edited.body.data.address.landmark, "Opposite the bakery");

      const switched = await request(app).patch(`/api/v1/addresses/${work.id}/default`).set(auth(customer.token));
      assert.equal(switched.body.data.address.isDefault, true);
      assert.equal((await Address.findById(home.id)).isDefault, false, "only one default at a time");

      assert.equal((await request(app).delete(`/api/v1/addresses/${home.id}`).set(auth(customer.token))).status, 200);
      const list = await request(app).get("/api/v1/addresses").set(auth(customer.token));
      assert.deepEqual(list.body.data.addresses.map((a) => a.id), [work.id]);
    });

    it("never lets one customer see or change another's address", async () => {
      const mine = (await create(customer.token)).body.data.address;
      const other = await registerUser(app);
      assert.equal((await request(app).patch(`/api/v1/addresses/${mine.id}`).set(auth(other.token)).send({ landmark: "x" })).status, 404);
      assert.equal((await request(app).patch(`/api/v1/addresses/${mine.id}/default`).set(auth(other.token))).status, 404);
      assert.equal((await request(app).delete(`/api/v1/addresses/${mine.id}`).set(auth(other.token))).status, 404);
      assert.equal((await request(app).get("/api/v1/addresses").set(auth(other.token))).body.data.addresses.length, 0);
    });
  });

  describe("payment administration", () => {
    let owner;

    beforeEach(async () => {
      owner = await seedCatalogFor(app);
      const { seedCheckoutData } = await import("../scripts/seed.js");
      await seedCheckoutData();
      await Restaurant.updateOne({ slug: "spice-route-kitchen" }, { openingTime: "00:00", closingTime: "00:00" });
    });

    async function paidOnlineOrder() {
      const food = await FoodItem.findOne({ name: "Butter Chicken" });
      await request(app).post("/api/v1/cart/items").set(auth(customer.token)).send({ foodItemId: food.id, quantity: 1 });
      await create(customer.token);
      const address = await Address.findOne({ user: customer.user.id });
      const placed = await request(app).post("/api/v1/orders").set(auth(customer.token)).send({ addressId: String(address._id), paymentMethod: "online" });
      assert.equal(placed.status, 201, JSON.stringify(placed.body));
      await request(app).post(`/api/v1/payments/orders/${placed.body.data.order.id}/mock`).set(auth(customer.token)).send({ outcome: "success" });
      return placed.body.data.order.id;
    }
    const create = (token) => request(app).post("/api/v1/addresses").set(auth(token)).send(ADDRESS);

    it("lists payments, flags failed refunds and retries them", async () => {
      const orderId = await paidOnlineOrder();
      // A rejection whose refund failed (gateway down): the order is closed, the money still taken.
      await Order.updateOne({ _id: orderId }, { $set: { status: "rejected" } });
      assert.equal((await Payment.findOne({ order: orderId })).status, "paid");

      const list = await request(app).get("/api/v1/admin/payments?method=online").set(auth(admin.token));
      assert.equal(list.status, 200);
      const row = list.body.data.items.find((p) => p.order?.id === orderId);
      assert.ok(row, "the payment is listed with its order");
      assert.equal(row.refundNeeded, true);

      const retried = await request(app).post(`/api/v1/admin/payments/${row.id}/refund`).set(auth(admin.token));
      assert.equal(retried.status, 200, JSON.stringify(retried.body));
      assert.equal(retried.body.data.payment.status, "refunded");
      assert.equal((await Order.findById(orderId)).paymentStatus, "refunded");
      assert.equal((await request(app).post(`/api/v1/admin/payments/${row.id}/refund`).set(auth(admin.token))).status, 409, "nothing left to refund");
    });

    it("is for admins only", async () => {
      assert.equal((await request(app).get("/api/v1/admin/payments").set(auth(customer.token))).status, 403);
      assert.equal((await request(app).get("/api/v1/admin/payments").set(auth(owner.token))).status, 403);
    });
  });
});
