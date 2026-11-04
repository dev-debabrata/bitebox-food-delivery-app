import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { PRICING } from "../config/pricing.js";
import { Address } from "../models/address.model.js";
import { Cart } from "../models/cart.model.js";
import { Coupon, CouponRedemption } from "../models/coupon.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { Order, Payment } from "../models/order.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { computePricing, couponDiscount, deliveryFee } from "../services/pricing.service.js";
import { resetTransactionSupportCache } from "../utils/transaction.js";
import { buildApp, createAndLogin, registerUser, request, resetDb, seedCatalogFor, setupTestDb, teardownTestDb } from "./helpers.js";

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const ADDRESS = {
  recipientName: "Asha",
  phone: "9000000002",
  line1: "Flat 4B, 80 Feet Road",
  city: "Bengaluru",
  state: "Karnataka",
  postalCode: "560034",
  location: { latitude: 12.9352, longitude: 77.6271 }, // ~4 km from the seeded restaurant
};

describe("pricing rules", () => {
  it("caps percentage coupons and never discounts more than the subtotal", () => {
    assert.equal(couponDiscount({ discountType: "percent", discountValue: 50, maxDiscountPaise: 10000 }, 50000), 10000);
    assert.equal(couponDiscount({ discountType: "percent", discountValue: 10 }, 33333), 3333);
    assert.equal(couponDiscount({ discountType: "flat", discountValue: 7500 }, 5000), 5000);
  });

  it("charges delivery by straight-line distance with a cap and a free threshold", () => {
    assert.equal(deliveryFee(1500, 10000), PRICING.deliveryBaseFeePaise);
    assert.equal(deliveryFee(4200, 10000), PRICING.deliveryBaseFeePaise + 3 * PRICING.deliveryPerKmPaise);
    assert.equal(deliveryFee(14000, 10000), PRICING.deliveryMaxFeePaise);
    assert.equal(deliveryFee(4200, PRICING.freeDeliveryThresholdPaise), 0);
  });

  it("adds tax on the discounted subtotal plus fees", () => {
    const p = computePricing({ subtotalPaise: 30000, coupon: { discountType: "flat", discountValue: 5000 }, distanceMeters: 1000 });
    assert.deepEqual(p, {
      subtotalPaise: 30000,
      discountPaise: 5000,
      deliveryFeePaise: 2500,
      platformFeePaise: 500,
      taxPaise: 1250, // 5% of 25000
      totalPaise: 25000 + 2500 + 500 + 1250,
    });
  });
});

for (const mode of ["transactions", "fallback"]) {
  describe(`cart and checkout (${mode})`, () => {
    let app;
    let customer;
    let food;

    before(async () => {
      if (mode === "fallback") process.env.DISABLE_TRANSACTIONS = "true";
      resetTransactionSupportCache();
      await setupTestDb();
      app = buildApp();
    });
    after(async () => {
      delete process.env.DISABLE_TRANSACTIONS;
      resetTransactionSupportCache();
      await teardownTestDb();
    });

    beforeEach(async () => {
      await resetDb();
      await seedCatalogFor(app);
      const { seedCheckoutData } = await import("../scripts/seed.js");
      await seedCheckoutData();
      // Open 24 hours so tests do not depend on the time of day.
      await Restaurant.updateOne({ slug: "spice-route-kitchen" }, { openingTime: "00:00", closingTime: "00:00" });
      customer = await createAndLogin(app, "customer");
      food = Object.fromEntries((await FoodItem.find()).map((f) => [f.name, f]));
    });

    const add = (token, foodItemId, quantity = 1, extra = {}) =>
      request(app).post("/api/v1/cart/items").set(auth(token)).send({ foodItemId, quantity, ...extra });
    const cart = (token) => request(app).get("/api/v1/cart").set(auth(token));
    const defaultAddressId = async (userId) => String((await Address.findOne({ user: userId, isDefault: true }))._id);
    const place = (token, body, key) => {
      const req = request(app).post("/api/v1/orders").set(auth(token));
      if (key) req.set("Idempotency-Key", key);
      return req.send({ paymentMethod: "cod", ...body });
    };

    describe("cart", () => {
      it("prices items from the database and ignores client-sent prices", async () => {
        const res = await add(customer.token, food["Butter Chicken"].id, 2, { pricePaise: 1, unitPricePaise: 1 });
        assert.equal(res.status, 200);
        const q = res.body.data;
        assert.equal(q.cart.items[0].unitPricePaise, 34900);
        assert.equal(q.pricing.subtotalPaise, 69800);
        assert.equal(q.cart.itemCount, 2);
        assert.equal(q.delivery.distanceKind, "straight_line");
      });

      it("increments, caps and removes quantities", async () => {
        await add(customer.token, food["Garlic Naan"].id, 15);
        const capped = await add(customer.token, food["Garlic Naan"].id, 10);
        assert.equal(capped.body.data.cart.items[0].quantity, 20);
        assert.equal((await add(customer.token, food["Garlic Naan"].id, 25)).status, 422);

        const set = await request(app).patch(`/api/v1/cart/items/${food["Garlic Naan"].id}`).set(auth(customer.token)).send({ quantity: 3 });
        assert.equal(set.body.data.cart.items[0].quantity, 3);
        const removed = await request(app).patch(`/api/v1/cart/items/${food["Garlic Naan"].id}`).set(auth(customer.token)).send({ quantity: 0 });
        assert.equal(removed.body.data.cart, null);
      });

      it("keeps a cart to one restaurant unless the customer chooses to start over", async () => {
        await add(customer.token, food["Garlic Naan"].id);
        const other = await Restaurant.create({
          ...(await Restaurant.findOne({ slug: "spice-route-kitchen" }).lean()),
          _id: undefined,
          owner: (await registerUser(app, { role: "restaurant" })).res.body.data.user.id,
          name: "Other Place",
          slug: "other-place",
        });
        const otherFood = await FoodItem.create({ restaurant: other._id, category: food["Garlic Naan"].category, name: "Pav Bhaji", pricePaise: 15000, isVeg: true });

        const conflict = await add(customer.token, otherFood.id);
        assert.equal(conflict.status, 409);
        assert.equal(conflict.body.error.code, "CART_RESTAURANT_CONFLICT");

        const replaced = await add(customer.token, otherFood.id, 1, { replace: true });
        assert.equal(replaced.status, 200);
        assert.deepEqual(replaced.body.data.cart.items.map((i) => i.name), ["Pav Bhaji"]);
      });

      it("refuses unavailable dishes and blocks checkout if one becomes unavailable", async () => {
        await FoodItem.updateOne({ _id: food["Mango Lassi"]._id }, { isAvailable: false });
        assert.equal((await add(customer.token, food["Mango Lassi"].id)).status, 409);

        await add(customer.token, food["Butter Chicken"].id);
        await FoodItem.updateOne({ _id: food["Butter Chicken"]._id }, { isAvailable: false });
        const q = (await cart(customer.token)).body.data;
        assert.equal(q.canCheckout, false);
        assert.ok(q.issues.some((i) => i.code === "ITEMS_UNAVAILABLE"));
        assert.equal(q.pricing.subtotalPaise, 0);
      });

      it("reports closed restaurants, minimum order and distance limits", async () => {
        await add(customer.token, food["Garlic Naan"].id); // ₹69 < ₹150 minimum
        let q = (await cart(customer.token)).body.data;
        assert.ok(q.issues.some((i) => i.code === "BELOW_MINIMUM"));

        await Restaurant.updateOne({ slug: "spice-route-kitchen" }, { isAcceptingOrders: false });
        q = (await cart(customer.token)).body.data;
        assert.ok(q.issues.some((i) => i.code === "RESTAURANT_CLOSED"));

        const far = await request(app)
          .post("/api/v1/addresses")
          .set(auth(customer.token))
          .send({ ...ADDRESS, city: "Mysuru", location: { latitude: 12.2958, longitude: 76.6394 } });
        q = (await request(app).get(`/api/v1/cart?addressId=${far.body.data.address.id}`).set(auth(customer.token))).body.data;
        assert.ok(q.issues.some((i) => i.code === "OUT_OF_RANGE"));
      });

      it("is only available to customers", async () => {
        const { token } = await createAndLogin(app, "restaurant");
        assert.equal((await cart(token)).status, 403);
        assert.equal((await request(app).get("/api/v1/cart")).status, 401);
      });
    });

    describe("addresses", () => {
      it("manages defaults and keeps addresses private to their owner", async () => {
        const fresh = await registerUser(app);
        const first = await request(app).post("/api/v1/addresses").set(auth(fresh.token)).send(ADDRESS);
        assert.equal(first.status, 201);
        assert.equal(first.body.data.address.isDefault, true, "first address becomes default");

        const second = await request(app).post("/api/v1/addresses").set(auth(fresh.token)).send({ ...ADDRESS, label: "work", isDefault: true });
        const list = await request(app).get("/api/v1/addresses").set(auth(fresh.token));
        assert.deepEqual(list.body.data.addresses.map((a) => [a.label, a.isDefault]), [["work", true], ["home", false]]);

        await request(app).delete(`/api/v1/addresses/${second.body.data.address.id}`).set(auth(fresh.token));
        const after = await request(app).get("/api/v1/addresses").set(auth(fresh.token));
        assert.equal(after.body.data.addresses[0].isDefault, true, "remaining address promoted to default");

        // Another customer cannot touch it.
        const res = await request(app).patch(`/api/v1/addresses/${first.body.data.address.id}`).set(auth(customer.token)).send({ city: "Hacked" });
        assert.equal(res.status, 404);
      });

      it("validates coordinates and required fields", async () => {
        const res = await request(app)
          .post("/api/v1/addresses")
          .set(auth(customer.token))
          .send({ ...ADDRESS, postalCode: "!", location: { latitude: 200, longitude: 77 } });
        assert.equal(res.status, 422);
      });
    });

    describe("coupons", () => {
      it("applies a valid coupon and recomputes the discount on the server", async () => {
        await add(customer.token, food["Butter Chicken"].id, 2); // ₹698
        const res = await request(app).post("/api/v1/cart/coupon").set(auth(customer.token)).send({ code: "welcome50" });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.coupon.code, "WELCOME50");
        assert.equal(res.body.data.pricing.discountPaise, 10000, "50% capped at ₹100");
      });

      it("rejects unknown, expired, below-minimum and wrong-restaurant coupons", async () => {
        await add(customer.token, food["Masala Dosa"].id); // ₹149
        const apply = (code) => request(app).post("/api/v1/cart/coupon").set(auth(customer.token)).send({ code });

        assert.equal((await apply("NOPE123")).status, 422);
        const min = await apply("WELCOME50");
        assert.equal(min.status, 422);
        assert.equal(min.body.error.code, "COUPON_MIN_ORDER");

        await Coupon.create({ code: "OLD10", discountType: "flat", discountValue: 1000, validFrom: new Date("2020-01-01"), validUntil: new Date("2020-02-01") });
        assert.match((await apply("OLD10")).body.message, /expired/);

        await Coupon.create({
          code: "ELSEWHERE",
          discountType: "flat",
          discountValue: 1000,
          validFrom: new Date(Date.now() - 1000),
          validUntil: new Date(Date.now() + 86_400_000),
          restaurant: "0123456789abcdef01234567",
        });
        assert.match((await apply("ELSEWHERE")).body.message, /not valid at this restaurant/);
      });

      it("drops a coupon from the bill when the cart no longer qualifies", async () => {
        await add(customer.token, food["Butter Chicken"].id, 2);
        await request(app).post("/api/v1/cart/coupon").set(auth(customer.token)).send({ code: "FLAT75" });
        const res = await request(app).patch(`/api/v1/cart/items/${food["Butter Chicken"].id}`).set(auth(customer.token)).send({ quantity: 1 });
        assert.equal(res.body.data.coupon, null);
        assert.equal(res.body.data.couponError.code, "FLAT75");
        assert.equal(res.body.data.pricing.discountPaise, 0);
        assert.equal(res.body.data.canCheckout, false);
      });
    });

    describe("placing orders", () => {
      it("creates an order with snapshots, a COD payment and an empty cart", async () => {
        await add(customer.token, food["Butter Chicken"].id, 2);
        await request(app).post("/api/v1/cart/coupon").set(auth(customer.token)).send({ code: "WELCOME50" });
        const quote = (await cart(customer.token)).body.data;
        const addressId = await defaultAddressId(customer.user.id);

        const res = await place(customer.token, { addressId, expectedTotalPaise: quote.pricing.totalPaise, note: "Ring the bell" });
        assert.equal(res.status, 201);
        const order = res.body.data.order;
        assert.match(order.orderNumber, /^BB-\d{6}-[A-Z2-9]{6}$/);
        assert.equal(order.status, "pending");
        assert.equal(order.paymentMethod, "cod");
        assert.equal(order.paymentStatus, "pending");
        assert.deepEqual(order.pricing, quote.pricing);
        assert.equal(order.items[0].unitPricePaise, 34900);
        assert.equal(order.deliveryAddress.city, "Bengaluru");
        assert.equal(order.restaurantSnapshot.name, "Spice Route Kitchen");
        assert.equal(order.idempotencyKey, undefined);

        assert.equal((await cart(customer.token)).body.data.cart, null);
        const payment = await Payment.findOne({ order: order.id });
        assert.equal(payment.amountPaise, quote.pricing.totalPaise);
        assert.equal((await Coupon.findOne({ code: "WELCOME50" })).usedCount, 1);
        assert.equal(await CouponRedemption.countDocuments(), 1);

        // Later menu price changes never alter the order.
        await FoodItem.updateOne({ _id: food["Butter Chicken"]._id }, { pricePaise: 99900 });
        const fetched = await request(app).get(`/api/v1/orders/${order.id}`).set(auth(customer.token));
        assert.equal(fetched.body.data.order.items[0].unitPricePaise, 34900);
      });

      it("refuses when the price changed since the customer saw it", async () => {
        await add(customer.token, food["Butter Chicken"].id, 2);
        const seen = (await cart(customer.token)).body.data.pricing.totalPaise;
        await FoodItem.updateOne({ _id: food["Butter Chicken"]._id }, { pricePaise: 39900 });
        const res = await place(customer.token, { addressId: await defaultAddressId(customer.user.id), expectedTotalPaise: seen });
        assert.equal(res.status, 409);
        assert.equal(res.body.error.code, "PRICE_CHANGED");
        assert.notEqual((await cart(customer.token)).body.data.cart, null, "cart kept");
      });

      it("returns the same order for a retried idempotency key", async () => {
        await add(customer.token, food["Butter Chicken"].id, 2);
        const addressId = await defaultAddressId(customer.user.id);
        const first = await place(customer.token, { addressId }, "checkout-key-123");
        const retry = await place(customer.token, { addressId }, "checkout-key-123");
        assert.equal(first.status, 201);
        assert.equal(retry.status, 200);
        assert.equal(retry.body.data.order.id, first.body.data.order.id);
        assert.equal(await Order.countDocuments(), 1);
      });

      it("never turns one cart into two orders, even when submitted twice at once", async () => {
        await add(customer.token, food["Butter Chicken"].id, 2);
        const addressId = await defaultAddressId(customer.user.id);
        const results = await Promise.all([place(customer.token, { addressId }), place(customer.token, { addressId })]);
        const statuses = results.map((r) => r.status).sort();
        assert.equal(statuses.filter((s) => s === 201).length, 1, `statuses: ${statuses}`);
        assert.equal(await Order.countDocuments(), 1);
        assert.equal(await Payment.countDocuments(), 1);
      });

      it("enforces coupon usage limits and restores the losing customer's cart", async () => {
        await Coupon.updateOne({ code: "WELCOME50" }, { usageLimit: 1 });
        const other = await registerUser(app);
        await request(app).post("/api/v1/addresses").set(auth(other.token)).send(ADDRESS);

        for (const token of [customer.token, other.token]) {
          await add(token, food["Butter Chicken"].id, 2);
          await request(app).post("/api/v1/cart/coupon").set(auth(token)).send({ code: "WELCOME50" });
        }
        const [a, b] = await Promise.all([
          place(customer.token, { addressId: await defaultAddressId(customer.user.id) }),
          place(other.token, { addressId: await defaultAddressId(other.res.body.data.user.id) }),
        ]);
        assert.deepEqual([a.status, b.status].filter((s) => s === 201).length, 1);
        assert.equal((await Coupon.findOne({ code: "WELCOME50" })).usedCount, 1);
        assert.equal(await Order.countDocuments(), 1);
        assert.equal(await Cart.countDocuments({ "items.0": { $exists: true } }), 1, "the losing cart is still there");
      });

      it("allows a coupon only once per customer", async () => {
        const addressId = await defaultAddressId(customer.user.id);
        await add(customer.token, food["Butter Chicken"].id, 2);
        await request(app).post("/api/v1/cart/coupon").set(auth(customer.token)).send({ code: "WELCOME50" });
        assert.equal((await place(customer.token, { addressId })).status, 201);

        await add(customer.token, food["Butter Chicken"].id, 2);
        const again = await request(app).post("/api/v1/cart/coupon").set(auth(customer.token)).send({ code: "WELCOME50" });
        assert.equal(again.status, 422);
        assert.equal(again.body.error.code, "COUPON_USED");
      });

      it("rejects empty carts, blocked carts and other people's addresses", async () => {
        const addressId = await defaultAddressId(customer.user.id);
        assert.equal((await place(customer.token, { addressId })).status, 400);

        await add(customer.token, food["Garlic Naan"].id); // below minimum
        const blocked = await place(customer.token, { addressId });
        assert.equal(blocked.status, 409);
        assert.equal(blocked.body.error.code, "CHECKOUT_BLOCKED");

        const other = await registerUser(app);
        const theirs = await request(app).post("/api/v1/addresses").set(auth(other.token)).send(ADDRESS);
        assert.equal((await place(customer.token, { addressId: theirs.body.data.address.id })).status, 404);
        assert.equal((await place(customer.token, { addressId, paymentMethod: "bitcoin" })).status, 422);
      });

      it("lists only the customer's own orders", async () => {
        await add(customer.token, food["Butter Chicken"].id, 2);
        const placed = await place(customer.token, { addressId: await defaultAddressId(customer.user.id) });
        const list = await request(app).get("/api/v1/orders").set(auth(customer.token));
        assert.equal(list.body.data.items.length, 1);
        assert.equal(list.body.data.items[0].orderNumber, placed.body.data.order.orderNumber);

        const other = await registerUser(app);
        assert.equal((await request(app).get(`/api/v1/orders/${placed.body.data.order.id}`).set(auth(other.token))).status, 404);
        assert.equal((await request(app).get("/api/v1/orders").set(auth(other.token))).body.data.items.length, 0);
      });
    });

    describe("admin coupons", () => {
      it("lets admins create coupons with validated rules and blocks others", async () => {
        const { token } = await createAndLogin(app, "admin");
        const body = { code: "monsoon20", discountType: "percent", discountValue: 20, maxDiscountPaise: 8000, validFrom: "2026-01-01", validUntil: "2027-01-01" };
        const created = await request(app).post("/api/v1/admin/coupons").set(auth(token)).send(body);
        assert.equal(created.status, 201);
        assert.equal(created.body.data.coupon.code, "MONSOON20");

        const bad = await request(app).post("/api/v1/admin/coupons").set(auth(token)).send({ ...body, code: "BAD100", discountValue: 150 });
        assert.equal(bad.status, 422);
        const backwards = await request(app).post("/api/v1/admin/coupons").set(auth(token)).send({ ...body, code: "BACK", validUntil: "2025-01-01" });
        assert.equal(backwards.status, 422);

        assert.equal((await request(app).post("/api/v1/admin/coupons").set(auth(customer.token)).send(body)).status, 403);

        // null clears an optional cap / usage limit on update.
        const id = created.body.data.coupon.id;
        const cleared = await request(app).patch(`/api/v1/admin/coupons/${id}`).set(auth(token)).send({ maxDiscountPaise: null, usageLimit: null });
        assert.equal(cleared.status, 200);
        assert.equal(cleared.body.data.coupon.maxDiscountPaise, null);
        assert.equal(cleared.body.data.coupon.usageLimit, null);
      });
    });
  });
}
