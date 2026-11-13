import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { env } from "../config/env.js";
import { FoodCategory } from "../models/food-category.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { Restaurant } from "../models/restaurant.model.js";
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

const restaurantPayload = (overrides = {}) => ({
  name: "Tandoor Tales",
  description: "Kebabs and curries",
  cuisines: ["North Indian", "Mughlai"],
  phone: "+919811112222",
  address: {
    line1: "5 MG Road",
    city: "Bengaluru",
    state: "Karnataka",
    postalCode: "560001",
  },
  location: { latitude: 12.9756, longitude: 77.6066 },
  costForTwoPaise: 60000,
  openingTime: "11:00",
  closingTime: "23:00",
  ...overrides,
});

// 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

describe("Restaurants, categories and food", () => {
  let app;
  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(async () => {
    await fs.rm(path.resolve(env.uploadDir), { recursive: true, force: true });
    await teardownTestDb();
  });
  beforeEach(resetDb);

  /** A second, independent restaurant partner with an approved restaurant. */
  async function otherRestaurant(name = "Other Place") {
    const { token, res } = await registerUser(app, { role: "restaurant" });
    assert.equal(res.status, 201);
    const created = await request(app)
      .post("/api/v1/my/restaurant")
      .set(auth(token))
      .send(restaurantPayload({ name }));
    assert.equal(created.status, 201);
    await Restaurant.updateOne(
      { _id: created.body.data.restaurant.id },
      { status: "approved" },
    );
    return { token, restaurant: created.body.data.restaurant };
  }

  it("lets the CDN cache public catalogue reads but never errors", async () => {
    const list = await request(app).get("/api/v1/categories");
    assert.equal(list.status, 200);
    assert.match(list.headers["cache-control"], /public.*s-maxage=60/);

    const missing = await request(app).get("/api/v1/restaurants/no-such-place");
    assert.equal(missing.status, 404);
    assert.equal(missing.headers["cache-control"], "no-store");
  });

  describe("restaurant onboarding (owner)", () => {
    it("creates a pending restaurant that is hidden from customers", async () => {
      const { token } = await registerUser(app, { role: "restaurant" });
      const res = await request(app)
        .post("/api/v1/my/restaurant")
        .set(auth(token))
        .send(restaurantPayload());
      assert.equal(res.status, 201);
      const r = res.body.data.restaurant;
      assert.equal(r.status, "pending");
      assert.equal(r.slug, "tandoor-tales");
      assert.deepEqual(r.location.coordinates, [77.6066, 12.9756]);

      assert.equal(
        (await request(app).get("/api/v1/restaurants/tandoor-tales")).status,
        404,
      );
      const list = await request(app).get("/api/v1/restaurants");
      assert.equal(list.body.data.items.length, 0);
    });

    it("ignores client attempts to set status, owner or rating", async () => {
      const { token } = await registerUser(app, { role: "restaurant" });
      const res = await request(app)
        .post("/api/v1/my/restaurant")
        .set(auth(token))
        .send(
          restaurantPayload({
            status: "approved",
            owner: "000000000000000000000000",
            rating: { average: 5, count: 999 },
          }),
        );
      assert.equal(res.status, 201);
      assert.equal(res.body.data.restaurant.status, "pending");
      assert.equal(res.body.data.restaurant.rating.count, 0);
    });

    it("allows only one restaurant per partner account", async () => {
      const { token } = await registerUser(app, { role: "restaurant" });
      await request(app)
        .post("/api/v1/my/restaurant")
        .set(auth(token))
        .send(restaurantPayload());
      const again = await request(app)
        .post("/api/v1/my/restaurant")
        .set(auth(token))
        .send(restaurantPayload({ name: "Second" }));
      assert.equal(again.status, 409);
    });

    it("validates required fields and coordinates", async () => {
      const { token } = await registerUser(app, { role: "restaurant" });
      const res = await request(app)
        .post("/api/v1/my/restaurant")
        .set(auth(token))
        .send(
          restaurantPayload({
            location: { latitude: 123, longitude: 77 },
            openingTime: "25:00",
            cuisines: [],
          }),
        );
      assert.equal(res.status, 422);
      const fields = res.body.error.details.map((d) => d.field);
      assert.ok(fields.includes("location.latitude"));
      assert.ok(fields.includes("openingTime"));
      assert.ok(fields.includes("cuisines"));
    });

    it("forbids non-restaurant roles from the partner endpoints", async () => {
      const { token } = await registerUser(app, { role: "customer" });
      assert.equal(
        (
          await request(app)
            .post("/api/v1/my/restaurant")
            .set(auth(token))
            .send(restaurantPayload())
        ).status,
        403,
      );
      assert.equal(
        (await request(app).get("/api/v1/my/restaurant/foods").set(auth(token)))
          .status,
        403,
      );
    });

    it("re-submits a rejected restaurant for review when edited", async () => {
      const { token } = await registerUser(app, { role: "restaurant" });
      const created = await request(app)
        .post("/api/v1/my/restaurant")
        .set(auth(token))
        .send(restaurantPayload());
      await Restaurant.updateOne(
        { _id: created.body.data.restaurant.id },
        { status: "rejected", statusReason: "Blurry photos" },
      );
      const res = await request(app)
        .patch("/api/v1/my/restaurant")
        .set(auth(token))
        .send({ description: "New photos uploaded" });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.restaurant.status, "pending");
      assert.equal(res.body.data.restaurant.statusReason, undefined);
    });

    it("lets the owner pause and resume orders", async () => {
      const { token } = await seedCatalogFor(app);
      const res = await request(app)
        .patch("/api/v1/my/restaurant/accepting-orders")
        .set(auth(token))
        .send({ isAcceptingOrders: false });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.restaurant.isAcceptingOrders, false);
      assert.equal(res.body.data.restaurant.isOpenNow, false);
    });
  });

  describe("admin approval workflow", () => {
    async function pendingRestaurant() {
      const { token } = await registerUser(app, { role: "restaurant" });
      const res = await request(app)
        .post("/api/v1/my/restaurant")
        .set(auth(token))
        .send(restaurantPayload());
      return res.body.data.restaurant.id;
    }

    it("approving makes the restaurant public", async () => {
      const id = await pendingRestaurant();
      const { token } = await createAndLogin(app, "admin");
      const res = await request(app)
        .patch(`/api/v1/admin/restaurants/${id}/status`)
        .set(auth(token))
        .send({ status: "approved" });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.restaurant.status, "approved");
      const pub = await request(app).get("/api/v1/restaurants/tandoor-tales");
      assert.equal(pub.status, 200);
      assert.equal(
        pub.body.data.restaurant.owner,
        undefined,
        "owner id is not exposed publicly",
      );
    });

    it("notifies admins of applications and owners of the decision", async () => {
      const { Notification } = await import("../models/notification.model.js");
      const admin = await createAndLogin(app, "admin");
      const owner = await registerUser(app, { role: "restaurant" });
      const inbox = async (token) =>
        (await request(app).get("/api/v1/notifications").set(auth(token))).body
          .data.items;

      const created = await request(app)
        .post("/api/v1/my/restaurant")
        .set(auth(owner.token))
        .send(restaurantPayload());
      const id = created.body.data.restaurant.id;
      const [applied] = await inbox(admin.token);
      assert.match(applied.title, /New restaurant application: Tandoor Tales/);
      assert.equal(applied.link, `/admin/restaurants/${id}`);

      await request(app)
        .patch(`/api/v1/admin/restaurants/${id}/status`)
        .set(auth(admin.token))
        .send({ status: "rejected", reason: "Blurry photos" });
      const [rejected] = await inbox(owner.token);
      assert.equal(rejected.type, "restaurant.rejected");
      assert.match(rejected.body, /Reason: Blurry photos/);

      await request(app)
        .patch("/api/v1/my/restaurant")
        .set(auth(owner.token))
        .send({ description: "New photos uploaded" });
      assert.match(
        (await inbox(admin.token))[0].title,
        /Restaurant resubmitted/,
      );

      await request(app)
        .patch(`/api/v1/admin/restaurants/${id}/status`)
        .set(auth(admin.token))
        .send({ status: "approved" });
      const [approved] = await inbox(owner.token);
      assert.equal(approved.title, "Your restaurant is live");
      assert.equal(approved.link, "/restaurant");
      assert.equal(
        await Notification.countDocuments({
          type: "restaurant.review",
          user: admin.user.id,
        }),
        2,
        "each admin with restaurants:manage: application + resubmission",
      );
    });

    it("requires a reason to reject and enforces the transition table", async () => {
      const id = await pendingRestaurant();
      const { token } = await createAndLogin(app, "admin");
      const noReason = await request(app)
        .patch(`/api/v1/admin/restaurants/${id}/status`)
        .set(auth(token))
        .send({ status: "rejected" });
      assert.equal(noReason.status, 400);
      const rejected = await request(app)
        .patch(`/api/v1/admin/restaurants/${id}/status`)
        .set(auth(token))
        .send({ status: "rejected", reason: "Missing FSSAI licence" });
      assert.equal(rejected.status, 200);
      assert.equal(
        rejected.body.data.restaurant.statusReason,
        "Missing FSSAI licence",
      );

      // rejected -> suspended is not an allowed transition
      const invalid = await request(app)
        .patch(`/api/v1/admin/restaurants/${id}/status`)
        .set(auth(token))
        .send({ status: "suspended", reason: "x" });
      assert.equal(invalid.status, 409);
    });

    it("suspending hides a restaurant from customers", async () => {
      await seedCatalogFor(app);
      const { token } = await createAndLogin(app, "admin");
      const r = await Restaurant.findOne({ slug: "spice-route-kitchen" });
      await request(app)
        .patch(`/api/v1/admin/restaurants/${r.id}/status`)
        .set(auth(token))
        .send({ status: "suspended", reason: "Hygiene audit" });
      assert.equal(
        (await request(app).get("/api/v1/restaurants/spice-route-kitchen"))
          .status,
        404,
      );
      const foods = await request(app).get("/api/v1/foods?search=biryani");
      assert.equal(foods.body.data.items.length, 0);
    });

    it("lists restaurants by status with counts for the admin", async () => {
      await pendingRestaurant();
      await seedCatalogFor(app);
      const { token } = await createAndLogin(app, "admin");
      const list = await request(app)
        .get("/api/v1/admin/restaurants?status=pending")
        .set(auth(token));
      assert.equal(list.status, 200);
      assert.equal(list.body.data.items.length, 1);
      assert.equal(
        list.body.data.items[0].owner.email.endsWith("@example.com"),
        true,
      );
      const counts = await request(app)
        .get("/api/v1/admin/restaurants/counts")
        .set(auth(token));
      assert.deepEqual(counts.body.data.counts, {
        pending: 1,
        approved: 1,
        rejected: 0,
        suspended: 0,
        resubmission_requested: 0,
      });
    });

    it("forbids non-admins from approving", async () => {
      const id = await pendingRestaurant();
      const { token } = await createAndLogin(app, "restaurant");
      const res = await request(app)
        .patch(`/api/v1/admin/restaurants/${id}/status`)
        .set(auth(token))
        .send({ status: "approved" });
      assert.equal(res.status, 403);
    });
  });

  describe("food categories (admin)", () => {
    it("creates, renames and lists categories; customers only see active ones", async () => {
      const { token } = await createAndLogin(app, "admin");
      const created = await request(app)
        .post("/api/v1/admin/categories")
        .set(auth(token))
        .send({ name: "Rolls & Wraps", icon: "kebab_dining" });
      assert.equal(created.status, 201);
      assert.equal(created.body.data.category.slug, "rolls-wraps");

      const dup = await request(app)
        .post("/api/v1/admin/categories")
        .set(auth(token))
        .send({ name: "rolls & wraps" });
      assert.equal(dup.status, 409);

      await request(app)
        .patch(`/api/v1/admin/categories/${created.body.data.category.id}`)
        .set(auth(token))
        .send({ isActive: false });
      const pub = await request(app).get("/api/v1/categories");
      assert.equal(pub.body.data.categories.length, 0);
    });

    it("refuses to delete a category that menu items use", async () => {
      await seedCatalogFor(app);
      const { token } = await createAndLogin(app, "admin");
      const biryani = await FoodCategory.findOne({ slug: "biryani" });
      const res = await request(app)
        .delete(`/api/v1/admin/categories/${biryani.id}`)
        .set(auth(token));
      assert.equal(res.status, 409);
      const pizza = await FoodCategory.findOne({ slug: "pizza" });
      assert.equal(
        (
          await request(app)
            .delete(`/api/v1/admin/categories/${pizza.id}`)
            .set(auth(token))
        ).status,
        200,
      );
    });

    it("forbids non-admins from managing categories", async () => {
      const { token } = await createAndLogin(app, "restaurant");
      assert.equal(
        (
          await request(app)
            .post("/api/v1/admin/categories")
            .set(auth(token))
            .send({ name: "Hacks" })
        ).status,
        403,
      );
    });
  });

  describe("menu management (owner)", () => {
    it("creates items with server-validated price and active category", async () => {
      const { token } = await seedCatalogFor(app);
      const category = await FoodCategory.findOne({ slug: "pizza" });
      const res = await request(app)
        .post("/api/v1/my/restaurant/foods")
        .set(auth(token))
        .send({
          name: "Margherita",
          category: category.id,
          pricePaise: 29900,
          isVeg: true,
          restaurant: "000000000000000000000000",
        });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.item.pricePaise, 29900);
      assert.equal(res.body.data.item.category.name, "Pizza");

      const restaurant = await Restaurant.findOne({
        slug: "spice-route-kitchen",
      });
      assert.equal(
        res.body.data.item.restaurant,
        restaurant.id,
        "restaurant comes from the owner, not the body",
      );

      const tooCheap = await request(app)
        .post("/api/v1/my/restaurant/foods")
        .set(auth(token))
        .send({
          name: "Free",
          category: category.id,
          pricePaise: 50,
          isVeg: true,
        });
      assert.equal(tooCheap.status, 422);

      const fractional = await request(app)
        .post("/api/v1/my/restaurant/foods")
        .set(auth(token))
        .send({
          name: "Odd",
          category: category.id,
          pricePaise: 199.5,
          isVeg: true,
        });
      assert.equal(fractional.status, 422);

      const dup = await request(app)
        .post("/api/v1/my/restaurant/foods")
        .set(auth(token))
        .send({
          name: "margherita",
          category: category.id,
          pricePaise: 100,
          isVeg: true,
        });
      assert.equal(dup.status, 409);
    });

    it("rejects inactive categories", async () => {
      const { token } = await seedCatalogFor(app);
      const category = await FoodCategory.findOneAndUpdate(
        { slug: "pizza" },
        { isActive: false },
      );
      const res = await request(app)
        .post("/api/v1/my/restaurant/foods")
        .set(auth(token))
        .send({
          name: "Margherita",
          category: category.id,
          pricePaise: 29900,
          isVeg: true,
        });
      assert.equal(res.status, 422);
    });

    it("toggles availability and soft-deletes items", async () => {
      const { token } = await seedCatalogFor(app);
      const item = await FoodItem.findOne({ name: "Masala Dosa" });

      const off = await request(app)
        .patch(`/api/v1/my/restaurant/foods/${item.id}/availability`)
        .set(auth(token))
        .send({ isAvailable: false });
      assert.equal(off.status, 200);
      assert.equal(off.body.data.item.isAvailable, false);

      const menu = await request(app).get(
        "/api/v1/restaurants/spice-route-kitchen/menu",
      );
      const dosa = menu.body.data.sections
        .flatMap((s) => s.items)
        .find((i) => i.name === "Masala Dosa");
      assert.equal(
        dosa.isAvailable,
        false,
        "unavailable items stay on the menu, flagged",
      );

      const search = await request(app).get("/api/v1/foods?search=dosa");
      assert.equal(
        search.body.data.items.length,
        0,
        "unavailable items are excluded from dish search",
      );

      assert.equal(
        (
          await request(app)
            .delete(`/api/v1/my/restaurant/foods/${item.id}`)
            .set(auth(token))
        ).status,
        200,
      );
      const after = await request(app).get(
        "/api/v1/restaurants/spice-route-kitchen/menu",
      );
      assert.ok(
        !after.body.data.sections
          .flatMap((s) => s.items)
          .some((i) => i.name === "Masala Dosa"),
      );
      assert.ok(
        await FoodItem.exists({ _id: item._id, deletedAt: { $ne: null } }),
        "kept in DB for history",
      );
    });

    it("prevents a restaurant from reading or changing another restaurant's items", async () => {
      await seedCatalogFor(app);
      const intruder = await otherRestaurant();
      const item = await FoodItem.findOne({ name: "Butter Chicken" });

      const update = await request(app)
        .patch(`/api/v1/my/restaurant/foods/${item.id}`)
        .set(auth(intruder.token))
        .send({ pricePaise: 100 });
      assert.equal(update.status, 404);
      const toggle = await request(app)
        .patch(`/api/v1/my/restaurant/foods/${item.id}/availability`)
        .set(auth(intruder.token))
        .send({ isAvailable: false });
      assert.equal(toggle.status, 404);
      const del = await request(app)
        .delete(`/api/v1/my/restaurant/foods/${item.id}`)
        .set(auth(intruder.token));
      assert.equal(del.status, 404);

      const list = await request(app)
        .get("/api/v1/my/restaurant/foods")
        .set(auth(intruder.token));
      assert.equal(list.body.data.items.length, 0);
      assert.equal((await FoodItem.findById(item._id)).pricePaise, 34900);
    });

    it("requires a restaurant profile before managing a menu", async () => {
      const { token } = await registerUser(app, { role: "restaurant" });
      assert.equal(
        (await request(app).get("/api/v1/my/restaurant/foods").set(auth(token)))
          .status,
        404,
      );
      const mine = await request(app)
        .get("/api/v1/my/restaurant")
        .set(auth(token));
      assert.equal(mine.body.data.restaurant, null);
    });
  });

  describe("customer discovery", () => {
    it("searches restaurants by name, cuisine and dish", async () => {
      await seedCatalogFor(app);
      await otherRestaurant("Pizza Planet");
      for (const [q, expected] of [
        ["spice", "Spice Route Kitchen"],
        ["mughlai", "Pizza Planet"],
        ["lassi", "Spice Route Kitchen"],
      ]) {
        const res = await request(app).get(`/api/v1/restaurants?search=${q}`);
        assert.deepEqual(
          res.body.data.items.map((r) => r.name),
          [expected],
          `search=${q}`,
        );
      }
    });

    it("filters by veg, cuisine and category", async () => {
      await seedCatalogFor(app);
      const other = await otherRestaurant("Green Leaf");
      await Restaurant.updateOne(
        { _id: other.restaurant.id },
        { isPureVeg: true },
      );

      const veg = await request(app).get("/api/v1/restaurants?veg=true");
      assert.deepEqual(
        veg.body.data.items.map((r) => r.name),
        ["Green Leaf"],
      );

      const cuisine = await request(app).get(
        "/api/v1/restaurants?cuisine=biryani",
      );
      assert.deepEqual(
        cuisine.body.data.items.map((r) => r.name),
        ["Spice Route Kitchen"],
      );

      const desserts = await FoodCategory.findOne({ slug: "desserts" });
      const byCategory = await request(app).get(
        `/api/v1/restaurants?category=${desserts.id}`,
      );
      assert.deepEqual(
        byCategory.body.data.items.map((r) => r.name),
        ["Spice Route Kitchen"],
      );
    });

    it("finds nearby restaurants with straight-line distance", async () => {
      await seedCatalogFor(app); // Indiranagar, Bengaluru
      const far = await otherRestaurant("Mumbai Masala");
      await Restaurant.updateOne(
        { _id: far.restaurant.id },
        { location: { type: "Point", coordinates: [72.8777, 19.076] } },
      );

      const res = await request(app).get(
        "/api/v1/restaurants?lat=12.9716&lng=77.5946&radiusKm=10",
      );
      assert.equal(res.status, 200);
      assert.deepEqual(
        res.body.data.items.map((r) => r.name),
        ["Spice Route Kitchen"],
      );
      const meters = res.body.data.items[0].distanceMeters;
      assert.ok(
        meters > 4000 && meters < 6000,
        `expected ~5 km, got ${meters}`,
      );
    });

    it("rejects distance sorting without coordinates and half-specified coordinates", async () => {
      assert.equal(
        (await request(app).get("/api/v1/restaurants?sort=distance")).status,
        400,
      );
      assert.equal(
        (await request(app).get("/api/v1/restaurants?lat=12.9")).status,
        422,
      );
      assert.equal(
        (await request(app).get("/api/v1/restaurants?lng=77.5")).status,
        422,
      );
    });

    it("paginates results", async () => {
      await seedCatalogFor(app);
      await otherRestaurant("Second Spot");
      const page1 = await request(app).get(
        "/api/v1/restaurants?limit=1&page=1&sort=newest",
      );
      const page2 = await request(app).get(
        "/api/v1/restaurants?limit=1&page=2&sort=newest",
      );
      assert.equal(page1.body.data.pagination.total, 2);
      assert.equal(page1.body.data.pagination.totalPages, 2);
      assert.notEqual(page1.body.data.items[0].id, page2.body.data.items[0].id);
    });

    it("returns the menu grouped by category in category order", async () => {
      await seedCatalogFor(app);
      const res = await request(app).get(
        "/api/v1/restaurants/spice-route-kitchen/menu",
      );
      assert.equal(res.status, 200);
      const names = res.body.data.sections.map((s) => s.category.name);
      assert.deepEqual(names, [
        "Biryani",
        "North Indian",
        "South Indian",
        "Desserts",
        "Beverages",
      ]);
    });

    it("searches dishes across approved restaurants only", async () => {
      await seedCatalogFor(app);
      const pending = await otherRestaurant("Hidden Biryani House");
      await Restaurant.updateOne(
        { _id: pending.restaurant.id },
        { status: "pending" },
      );
      const category = await FoodCategory.findOne({ slug: "biryani" });
      await FoodItem.create({
        restaurant: pending.restaurant.id,
        category: category._id,
        name: "Secret Biryani",
        pricePaise: 20000,
        isVeg: false,
      });

      const res = await request(app).get("/api/v1/foods?search=biryani");
      const names = res.body.data.items.map((i) => i.name).sort();
      assert.deepEqual(names, [
        "Hyderabadi Chicken Biryani",
        "Paneer Tikka Biryani",
      ]);
      assert.equal(
        res.body.data.items[0].restaurant.slug,
        "spice-route-kitchen",
      );

      const veg = await request(app).get(
        "/api/v1/foods?search=biryani&veg=true",
      );
      assert.deepEqual(
        veg.body.data.items.map((i) => i.name),
        ["Paneer Tikka Biryani"],
      );
    });

    it("returns dish details with restaurant open state", async () => {
      await seedCatalogFor(app);
      const item = await FoodItem.findOne({ name: "Mango Lassi" });
      const res = await request(app).get(`/api/v1/foods/${item.id}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.item.restaurant.name, "Spice Route Kitchen");
      assert.equal(typeof res.body.data.item.restaurant.isOpenNow, "boolean");
    });
  });

  describe("image uploads", () => {
    it("stores a real image under a random name and serves it cross-origin", async () => {
      const { token } = await createAndLogin(app, "restaurant");
      const res = await request(app)
        .post("/api/v1/uploads/images")
        .set(auth(token))
        .attach("image", PNG, "photo.png");
      assert.equal(res.status, 201);
      assert.equal(res.body.data.type, "png");
      const url = new URL(res.body.data.url);
      assert.match(url.pathname, /^\/uploads\/images\/[0-9a-f-]{36}\.png$/);

      const served = await request(app).get(url.pathname);
      assert.equal(served.status, 200);
      assert.equal(
        served.headers["cross-origin-resource-policy"],
        "cross-origin",
      );
      assert.equal(served.headers["x-content-type-options"], "nosniff");
    });

    it("uploads to Cloudinary when it is configured", async () => {
      const { default: cloudinary } = await import("../config/cloudinary.js");
      const { cloudinaryStorage, useImageStorage } =
        await import("../services/upload.service.js");
      const sent = [];
      const realStream = cloudinary.uploader.upload_stream;
      cloudinary.config({ cloud_name: "demo-cloud" });
      cloudinary.uploader.upload_stream = (options, done) => ({
        end: (buffer) => {
          sent.push({ options, bytes: buffer.length });
          done(null, { public_id: "bitebox/abc123", version: 1700000000 });
        },
      });
      const restore = useImageStorage(cloudinaryStorage);
      try {
        const { token } = await createAndLogin(app, "restaurant");
        const res = await request(app)
          .post("/api/v1/uploads/images")
          .set(auth(token))
          .attach("image", PNG, "photo.png");
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(
          res.body.data.url,
          "https://res.cloudinary.com/demo-cloud/image/upload/f_auto,q_auto/v1700000000/bitebox/abc123",
        );
        assert.equal(sent.length, 1);
        assert.equal(sent[0].options.folder, env.cloudinary.folder);
        assert.equal(
          sent[0].bytes,
          PNG.length,
          "the checked bytes are what gets uploaded",
        );

        cloudinary.uploader.upload_stream = (_options, done) => ({
          end: () => done(new Error("network down")),
        });
        const failed = await request(app)
          .post("/api/v1/uploads/images")
          .set(auth(token))
          .attach("image", PNG, "photo.png");
        assert.equal(failed.status, 503);
        assert.equal(failed.body.error.code, "UPLOAD_FAILED");
      } finally {
        restore();
        cloudinary.uploader.upload_stream = realStream;
      }
    });

    it("rejects files whose bytes are not an image, whatever their name", async () => {
      const { token } = await createAndLogin(app, "admin");
      const res = await request(app)
        .post("/api/v1/uploads/images")
        .set(auth(token))
        .attach("image", Buffer.from("<script>alert(1)</script>"), {
          filename: "evil.png",
          contentType: "image/png",
        });
      assert.equal(res.status, 415);
    });

    it("rejects files over 2 MB", async () => {
      const { token } = await createAndLogin(app, "restaurant");
      const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
      const res = await request(app)
        .post("/api/v1/uploads/images")
        .set(auth(token))
        .attach("image", big, "big.png");
      assert.equal(res.status, 413);
    });

    it("only allows restaurant partners and admins to upload", async () => {
      const { token } = await registerUser(app);
      const res = await request(app)
        .post("/api/v1/uploads/images")
        .set(auth(token))
        .attach("image", PNG, "photo.png");
      assert.equal(res.status, 403);
    });
  });
});
