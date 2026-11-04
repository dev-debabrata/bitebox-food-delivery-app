import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { Address } from "../models/address.model.js";
import { DeliveryPartner } from "../models/delivery-partner.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { Order } from "../models/order.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { Review, ReviewReport } from "../models/review.model.js";
import { refreshRating } from "../services/review.service.js";
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
const NEAR = { latitude: 12.9729, longitude: 77.6412 };
const DAY = 86_400_000;

describe("ratings and reviews", () => {
  let app;
  let customer;
  let owner;
  let rider;
  let admin;
  let food;

  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(teardownTestDb);

  beforeEach(async () => {
    await resetDb();
    owner = await seedCatalogFor(app);
    const { seedCheckoutData, seedDeliveryData } =
      await import("../scripts/seed.js");
    await seedCheckoutData();
    await seedDeliveryData();
    await Restaurant.updateOne(
      { slug: "spice-route-kitchen" },
      { openingTime: "00:00", closingTime: "00:00" },
    );
    customer = await createAndLogin(app, "customer");
    rider = await createAndLogin(app, "delivery");
    admin = await createAndLogin(app, "admin");
    food = Object.fromEntries((await FoodItem.find()).map((f) => [f.name, f]));
  });

  // -- helpers ---------------------------------------------------------------
  async function placeOrder(who = customer, dishes = ["Butter Chicken"]) {
    for (const name of dishes)
      await request(app)
        .post("/api/v1/cart/items")
        .set(auth(who.token))
        .send({ foodItemId: food[name].id, quantity: 1 });
    let address = await Address.findOne({ user: who.user.id, isDefault: true });
    if (!address) {
      const res = await request(app)
        .post("/api/v1/addresses")
        .set(auth(who.token))
        .send({
          recipientName: "Meera Test",
          phone: "9000000099",
          line1: "12 Lotus Lane",
          city: "Bengaluru",
          state: "Karnataka",
          postalCode: "560038",
          location: { latitude: 12.975, longitude: 77.64 },
        });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      address = { _id: res.body.data.address.id };
    }
    const res = await request(app)
      .post("/api/v1/orders")
      .set(auth(who.token))
      .send({ addressId: String(address._id), paymentMethod: "cod" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data.order.id;
  }

  /** A real order driven through the real workflow to "delivered". */
  async function deliveredOrder(who = customer, dishes) {
    await request(app)
      .patch("/api/v1/delivery/me/availability")
      .set(auth(rider.token))
      .send({ isOnline: true, ...NEAR });
    const id = await placeOrder(who, dishes);
    for (const status of ["confirmed", "preparing", "ready_for_pickup"]) {
      const res = await request(app)
        .patch(`/api/v1/my/restaurant/orders/${id}/status`)
        .set(auth(owner.token))
        .send({ status });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    assert.equal(
      (
        await request(app)
          .post(`/api/v1/delivery/offers/${id}/accept`)
          .set(auth(rider.token))
      ).status,
      200,
    );
    for (const status of ["picked_up", "on_the_way", "delivered"])
      await request(app)
        .patch(`/api/v1/delivery/orders/${id}/status`)
        .set(auth(rider.token))
        .send({ status });
    assert.equal((await Order.findById(id)).status, "delivered");
    return id;
  }

  const review = (token, body) =>
    request(app).post("/api/v1/reviews").set(auth(token)).send(body);
  const rateRestaurant = (token, orderId, rating, comment) =>
    review(token, { orderId, target: "restaurant", rating, comment });

  async function secondCustomer() {
    const { token, res } = await registerUser(app, { name: "Kiran Mehta" });
    return { token, user: res.body.data.user };
  }

  // -- eligibility -------------------------------------------------------------
  describe("who can review what", () => {
    it("rejects reviews for orders that are not delivered", async () => {
      const id = await placeOrder();
      const res = await rateRestaurant(customer.token, id, 5);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "ORDER_NOT_DELIVERED");
      const state = await request(app)
        .get(`/api/v1/orders/${id}/reviews`)
        .set(auth(customer.token));
      assert.equal(state.body.data.canReview, false);
      assert.equal(await Review.countDocuments(), 0);
    });

    it("needs a signed-in customer", async () => {
      const id = await deliveredOrder();
      const anonymous = await request(app)
        .post("/api/v1/reviews")
        .send({ orderId: id, target: "restaurant", rating: 5 });
      assert.equal(anonymous.status, 401);
      for (const who of [owner, rider, admin]) {
        const res = await rateRestaurant(who.token, id, 1);
        assert.equal(res.status, 403, "only customers write reviews");
      }
    });

    it("never lets a customer review someone else's order", async () => {
      const id = await deliveredOrder();
      const other = await secondCustomer();
      const res = await rateRestaurant(other.token, id, 1);
      assert.equal(res.status, 404, "the order id from the client is not trusted");
      const state = await request(app)
        .get(`/api/v1/orders/${id}/reviews`)
        .set(auth(other.token));
      assert.equal(state.status, 404);
    });

    it("closes the review window after the policy period", async () => {
      const id = await deliveredOrder();
      await Order.updateOne(
        { _id: id, "statusHistory.status": "delivered" },
        { $set: { "statusHistory.$.at": new Date(Date.now() - 31 * DAY) } },
      );
      const res = await rateRestaurant(customer.token, id, 4);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "REVIEW_WINDOW_CLOSED");
    });

    it("validates the rating, the dish and the comment", async () => {
      const id = await deliveredOrder();
      for (const rating of [0, 6, 3.5, "five", null]) {
        const res = await rateRestaurant(customer.token, id, rating);
        assert.equal(res.status, 422, `rating ${rating}`);
        assert.equal(res.body.error.details[0].field, "rating");
      }
      const tooLong = await rateRestaurant(customer.token, id, 4, "x".repeat(1001));
      assert.equal(tooLong.status, 422);

      const noDish = await review(customer.token, {
        orderId: id,
        target: "food",
        rating: 4,
      });
      assert.equal(noDish.status, 422);
      const notOrdered = await review(customer.token, {
        orderId: id,
        target: "food",
        foodItemId: food["Masala Dosa"].id,
        rating: 4,
      });
      assert.equal(notOrdered.status, 422, "only dishes that were in the order");
      const badTarget = await review(customer.token, {
        orderId: id,
        target: "admin",
        rating: 4,
      });
      assert.equal(badTarget.status, 422);
      assert.equal(await Review.countDocuments(), 0);
    });
  });

  // -- the customer journey ------------------------------------------------------
  it("reviews the restaurant, each dish and the rider once each", async () => {
    const id = await deliveredOrder(customer, ["Butter Chicken", "Garlic Naan"]);

    const before = await request(app)
      .get(`/api/v1/orders/${id}/reviews`)
      .set(auth(customer.token));
    assert.equal(before.body.data.canReview, true);
    assert.equal(before.body.data.items.length, 2);
    assert.ok(before.body.data.rider, "a rider delivered this order");

    const r = await rateRestaurant(customer.token, id, 4, "  Lovely food, quick service ");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.review.comment, "Lovely food, quick service");
    assert.equal(r.body.data.review.authorName, "Asha C.");
    const f = await review(customer.token, {
      orderId: id,
      target: "food",
      foodItemId: food["Butter Chicken"].id,
      rating: 5,
    });
    assert.equal(f.status, 201);
    const d = await review(customer.token, { orderId: id, target: "rider", rating: 3 });
    assert.equal(d.status, 201);

    // Duplicates, including racing double-submits, hit the unique index.
    const results = await Promise.all([
      rateRestaurant(customer.token, id, 1),
      rateRestaurant(customer.token, id, 2),
    ]);
    for (const res of results) {
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "DUPLICATE_REVIEW");
    }
    const again = await review(customer.token, {
      orderId: id,
      target: "food",
      foodItemId: food["Butter Chicken"].id,
      rating: 1,
    });
    assert.equal(again.status, 409);
    assert.equal(await Review.countDocuments(), 3);

    // Summaries on each subject.
    const restaurant = await Restaurant.findOne({ slug: "spice-route-kitchen" });
    assert.deepEqual(
      { ...restaurant.rating.toObject() },
      { average: 4, count: 1, distribution: [0, 0, 0, 1, 0] },
    );
    assert.equal((await FoodItem.findById(food["Butter Chicken"].id)).rating.average, 5);
    assert.equal((await FoodItem.findById(food["Garlic Naan"].id)).rating.count, 0);
    const profile = await DeliveryPartner.findOne({ user: rider.user.id });
    assert.equal(profile.rating.average, 3);

    const after = await request(app)
      .get(`/api/v1/orders/${id}/reviews`)
      .set(auth(customer.token));
    assert.equal(after.body.data.restaurant.review.rating, 4);
    assert.equal(after.body.data.items[0].review.rating, 5);
    assert.equal(after.body.data.items[1].review, null);
    assert.equal(after.body.data.rider.review.rating, 3);

    const history = await request(app).get("/api/v1/orders").set(auth(customer.token));
    assert.equal(history.body.data.items[0].myRating, 4, "shown in order history");

    const mine = await request(app).get("/api/v1/reviews/mine").set(auth(customer.token));
    assert.equal(mine.body.data.items.length, 3);
    assert.equal(mine.body.data.items[0].restaurantName, "Spice Route Kitchen");

    const card = await request(app).get(`/api/v1/orders/${id}`).set(auth(customer.token));
    assert.deepEqual(card.body.data.order.rider.rating, { average: 3, count: 1 });
  });

  it("lets the author edit (keeping history) and delete, and nobody else", async () => {
    const id = await deliveredOrder();
    const created = await rateRestaurant(customer.token, id, 5, "Great");
    const reviewId = created.body.data.review.id;

    const other = await secondCustomer();
    for (const who of [other, owner, rider]) {
      const patch = await request(app)
        .patch(`/api/v1/reviews/${reviewId}`)
        .set(auth(who.token))
        .send({ rating: 1 });
      assert.ok([403, 404].includes(patch.status), `${patch.status}`);
      const del = await request(app)
        .delete(`/api/v1/reviews/${reviewId}`)
        .set(auth(who.token));
      assert.ok([403, 404].includes(del.status));
    }
    assert.equal(
      (await request(app).get(`/api/v1/reviews/${reviewId}`).set(auth(other.token))).status,
      404,
    );

    const empty = await request(app)
      .patch(`/api/v1/reviews/${reviewId}`)
      .set(auth(customer.token))
      .send({});
    assert.equal(empty.status, 422);

    const edited = await request(app)
      .patch(`/api/v1/reviews/${reviewId}`)
      .set(auth(customer.token))
      .send({ rating: 2, comment: "Cold on arrival" });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.data.review.rating, 2);
    assert.ok(edited.body.data.review.editedAt);
    const stored = await Review.findById(reviewId).select("+edits");
    assert.deepEqual(
      stored.edits.map((e) => [e.rating, e.comment]),
      [[5, "Great"]],
      "the earlier version is kept",
    );
    assert.equal((await Restaurant.findOne()).rating.average, 2);

    // createdAt is immutable through Mongoose, so backdate it on the raw collection.
    await Review.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(reviewId) },
      { $set: { createdAt: new Date(Date.now() - 31 * DAY) } },
    );
    const late = await request(app)
      .patch(`/api/v1/reviews/${reviewId}`)
      .set(auth(customer.token))
      .send({ rating: 3 });
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, "EDIT_WINDOW_CLOSED");

    const del = await request(app)
      .delete(`/api/v1/reviews/${reviewId}`)
      .set(auth(customer.token));
    assert.equal(del.status, 200);
    assert.equal((await Review.findById(reviewId)).status, "deleted");
    assert.equal((await Restaurant.findOne()).rating.count, 0, "summary updated");
    const recreate = await rateRestaurant(customer.token, id, 5);
    assert.equal(recreate.status, 409, "deleting is final for this order");
    assert.equal(
      (await request(app).get("/api/v1/reviews/mine").set(auth(customer.token))).body
        .data.items.length,
      0,
    );
  });

  // -- restaurant and rider panels -------------------------------------------------
  it("lets the restaurant read, filter and reply without touching the review", async () => {
    const id = await deliveredOrder(customer, ["Butter Chicken", "Garlic Naan"]);
    const r = (await rateRestaurant(customer.token, id, 2, "Too salty")).body.data
      .review;
    await review(customer.token, {
      orderId: id,
      target: "food",
      foodItemId: food["Garlic Naan"].id,
      rating: 5,
    });
    await review(customer.token, { orderId: id, target: "rider", rating: 1 });

    const list = await request(app)
      .get("/api/v1/my/restaurant/reviews/orders")
      .set(auth(owner.token));
    assert.equal(list.status, 200);
    assert.equal(list.body.data.items.length, 1);
    const reviewsSeen = list.body.data.items[0].reviews;
    assert.equal(reviewsSeen.length, 2, "never the rider's reviews");
    const item = reviewsSeen.find((x) => x.target === "restaurant");
    assert.equal(item.customer, undefined, "no customer id");
    assert.equal(item.authorName, "Asha C.");

    const filtered = await request(app)
      .get("/api/v1/my/restaurant/reviews/orders?target=food&rating=5&sort=lowest&limit=1")
      .set(auth(owner.token));
    assert.equal(filtered.body.data.pagination.total, 1);
    const none = await request(app)
      .get("/api/v1/my/restaurant/reviews/orders?target=food&rating=1")
      .set(auth(owner.token));
    assert.equal(none.body.data.items.length, 0);

    const summary = await request(app)
      .get("/api/v1/my/restaurant/reviews/summary")
      .set(auth(owner.token));
    assert.equal(summary.body.data.rating.average, 2);
    assert.equal(summary.body.data.unanswered, 2);
    assert.equal(
      summary.body.data.foods.find((f) => f.name === "Garlic Naan").rating.count,
      1,
    );

    const reply = await request(app)
      .put(`/api/v1/my/restaurant/reviews/${r.id}/response`)
      .set(auth(owner.token))
      .send({ text: "Sorry about that, we have adjusted the recipe." });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.review.comment, "Too salty", "review untouched");
    assert.equal(reply.body.data.review.rating, 2);
    const unanswered = await request(app)
      .get(`/api/v1/my/restaurant/reviews/orders/${id}`)
      .set(auth(owner.token));
    assert.equal(unanswered.body.data.unanswered, 1);

    // Customers and riders cannot reply as the restaurant; the restaurant cannot edit or delete.
    for (const who of [customer, rider]) {
      const res = await request(app)
        .put(`/api/v1/my/restaurant/reviews/${r.id}/response`)
        .set(auth(who.token))
        .send({ text: "Fake reply" });
      assert.equal(res.status, 403);
    }
    const riderReview = await Review.findOne({ target: "rider" });
    const notTheirs = await request(app)
      .put(`/api/v1/my/restaurant/reviews/${riderReview.id}/response`)
      .set(auth(owner.token))
      .send({ text: "Not ours" });
    assert.equal(notTheirs.status, 404);

    const pub = await request(app).get("/api/v1/restaurants/spice-route-kitchen/reviews");
    assert.equal(pub.status, 200);
    assert.equal(pub.body.data.items.length, 1);
    assert.match(pub.body.data.items[0].response.text, /adjusted the recipe/);
    assert.deepEqual(pub.body.data.summary.distribution, [0, 1, 0, 0, 0]);

    const removed = await request(app)
      .delete(`/api/v1/my/restaurant/reviews/${r.id}/response`)
      .set(auth(owner.token));
    assert.equal(removed.body.data.review.response, null);

    const dish = await request(app).get(
      `/api/v1/foods/${food["Garlic Naan"].id}/reviews`,
    );
    assert.equal(dish.body.data.summary.average, 5);
    assert.equal(dish.body.data.items[0].foodName, "Garlic Naan");
  });

  it("shows riders their ratings without the customer's details", async () => {
    const id = await deliveredOrder();
    const created = await review(customer.token, {
      orderId: id,
      target: "rider",
      rating: 4,
      comment: "Polite and on time",
    });
    await rateRestaurant(customer.token, id, 1);

    const res = await request(app).get("/api/v1/delivery/reviews").set(auth(rider.token));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.summary.average, 4);
    assert.equal(res.body.data.items.length, 1, "only reviews of the rider");
    const [item] = res.body.data.items;
    assert.equal(item.authorName, "Asha", "first name only");
    assert.deepEqual(
      Object.keys(item).sort(),
      ["authorName", "comment", "createdAt", "editedAt", "id", "orderNumber", "rating", "reportedByYou"],
    );

    const otherRider = await registerUser(app, { role: "delivery", name: "Dev Rider" });
    const theirs = await request(app)
      .get("/api/v1/delivery/reviews")
      .set(auth(otherRider.token));
    assert.equal(theirs.body.data.items.length, 0);

    const patch = await request(app)
      .patch(`/api/v1/reviews/${created.body.data.review.id}`)
      .set(auth(rider.token))
      .send({ rating: 5 });
    assert.equal(patch.status, 403);

    const report = await request(app)
      .post(`/api/v1/reviews/${created.body.data.review.id}/reports`)
      .set(auth(rider.token))
      .send({ reason: "harassment" });
    assert.equal(report.status, 201, "riders may report reviews of themselves");
    const notAboutThem = await request(app)
      .post(`/api/v1/reviews/${created.body.data.review.id}/reports`)
      .set(auth(otherRider.token))
      .send({ reason: "spam" });
    assert.equal(notAboutThem.status, 404);
  });

  // -- reports and moderation ---------------------------------------------------------
  it("reports, then hides, restores and removes with a logged reason", async () => {
    const id = await deliveredOrder();
    const reviewId = (await rateRestaurant(customer.token, id, 1, "Rude staff, call 9000000000"))
      .body.data.review.id;
    const other = await secondCustomer();
    const report = (who, body = { reason: "personal_info" }) =>
      request(app)
        .post(`/api/v1/reviews/${reviewId}/reports`)
        .set(auth(who.token))
        .send(body);

    assert.equal((await report(customer)).status, 400, "not your own review");
    assert.equal((await report(other, { reason: "nonsense" })).status, 422);
    assert.equal((await report(other)).status, 201);
    assert.equal((await report(other)).body.error.code, "ALREADY_REPORTED");
    assert.equal((await report(owner, { reason: "fake" })).status, 201);
    assert.equal((await Review.findById(reviewId)).openReports, 2);

    const queue = await request(app)
      .get("/api/v1/admin/reviews/orders?reported=true")
      .set(auth(admin.token));
    assert.equal(queue.status, 200);
    assert.equal(queue.body.data.items[0].reviews[0].id, reviewId);
    assert.equal(queue.body.data.counts.reported, 1);
    for (const who of [customer, owner, rider])
      assert.equal(
        (await request(app).get("/api/v1/admin/reviews/orders").set(auth(who.token))).status,
        403,
      );

    const moderate = (body) =>
      request(app)
        .post(`/api/v1/admin/reviews/${reviewId}/moderation`)
        .set(auth(admin.token))
        .send(body);
    assert.equal((await moderate({ action: "hide" })).status, 422, "a reason is required");

    const hidden = await moderate({ action: "hide", reason: "Contains a phone number" });
    assert.equal(hidden.status, 200);
    assert.equal(hidden.body.data.review.status, "hidden");
    assert.equal(hidden.body.data.review.openReports, 0, "reports closed as actioned");
    assert.equal(
      (await ReviewReport.find()).every((r) => r.status === "actioned"),
      true,
    );
    assert.equal((await Restaurant.findOne()).rating.count, 0, "excluded from the average");
    const pub = await request(app).get("/api/v1/restaurants/spice-route-kitchen/reviews");
    assert.equal(pub.body.data.items.length, 0);
    assert.equal(
      (await request(app).get("/api/v1/my/restaurant/reviews/orders").set(auth(owner.token)))
        .body.data.items.length,
      0,
    );

    const own = await request(app)
      .get(`/api/v1/reviews/${reviewId}`)
      .set(auth(customer.token));
    assert.equal(own.body.data.review.status, "hidden");
    assert.equal(own.body.data.review.moderation.reason, "Contains a phone number");
    const edit = await request(app)
      .patch(`/api/v1/reviews/${reviewId}`)
      .set(auth(customer.token))
      .send({ comment: "Rude staff" });
    assert.equal(edit.body.error.code, "REVIEW_LOCKED");

    assert.equal(
      (await moderate({ action: "hide", reason: "again" })).status,
      200,
      "repeating a move is a no-op",
    );
    assert.equal(
      (await moderate({ action: "restore", reason: "Customer was contacted" })).body.data
        .review.status,
      "published",
    );
    assert.equal((await Restaurant.findOne()).rating.count, 1);
    const removed = await moderate({ action: "remove", reason: "Policy: personal data" });
    assert.equal(removed.body.data.review.status, "removed");
    const invalid = await moderate({ action: "hide", reason: "Not allowed" });
    assert.equal(invalid.status, 409);
    assert.equal(invalid.body.error.code, "INVALID_MODERATION");

    const detail = await request(app)
      .get(`/api/v1/admin/reviews/${reviewId}`)
      .set(auth(admin.token));
    const log = detail.body.data.review.moderationLog;
    assert.deepEqual(
      log.map((m) => [m.action, m.fromStatus, m.toStatus]),
      [
        ["hide", "published", "hidden"],
        ["restore", "hidden", "published"],
        ["remove", "published", "removed"],
      ],
    );
    assert.equal(log[0].by.name, "BiteBox Admin");
    assert.equal(detail.body.data.review.reports.length, 2);
    assert.equal(
      detail.body.data.review.comment,
      "Rude staff, call 9000000000",
      "admins never rewrite the words",
    );
    assert.equal(
      (
        await request(app)
          .patch(`/api/v1/admin/reviews/${reviewId}`)
          .set(auth(admin.token))
          .send({ comment: "edited" })
      ).status,
      404,
      "there is no admin edit endpoint",
    );
  });

  it("dismisses reports without changing the review", async () => {
    const id = await deliveredOrder();
    const reviewId = (await rateRestaurant(customer.token, id, 3, "Average")).body.data
      .review.id;
    const other = await secondCustomer();
    await request(app)
      .post(`/api/v1/reviews/${reviewId}/reports`)
      .set(auth(other.token))
      .send({ reason: "spam" });
    const res = await request(app)
      .post(`/api/v1/admin/reviews/${reviewId}/reports/dismiss`)
      .set(auth(admin.token))
      .send({ reason: "Honest opinion" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.review.status, "published");
    assert.equal(res.body.data.review.openReports, 0);
    assert.equal(res.body.data.review.reports[0].status, "dismissed");
    assert.equal(res.body.data.review.moderationLog[0].action, "dismiss_reports");
    const again = await request(app)
      .post(`/api/v1/admin/reviews/${reviewId}/reports/dismiss`)
      .set(auth(admin.token))
      .send({ reason: "Again" });
    assert.equal(again.body.error.code, "NO_OPEN_REPORTS");
  });

  // -- aggregation ---------------------------------------------------------------------
  it("keeps averages, counts and distributions exact", async () => {
    const ratings = [5, 4, 1, 4];
    const ids = [];
    for (const rating of ratings) {
      const id = await deliveredOrder();
      const res = await rateRestaurant(customer.token, id, rating);
      ids.push(res.body.data.review.id);
    }
    let summary = (await Restaurant.findOne()).rating;
    assert.equal(summary.count, 4);
    assert.equal(summary.average, 3.5);
    assert.deepEqual([...summary.distribution], [1, 0, 0, 2, 1]);

    await request(app)
      .post(`/api/v1/admin/reviews/${ids[2]}/moderation`)
      .set(auth(admin.token))
      .send({ action: "remove", reason: "Spam" });
    await request(app)
      .patch(`/api/v1/reviews/${ids[0]}`)
      .set(auth(customer.token))
      .send({ rating: 3 });
    summary = (await Restaurant.findOne()).rating;
    assert.equal(summary.count, 3);
    assert.equal(summary.average, 3.67, "(3 + 4 + 4) / 3, rounded to 2 places");
    assert.deepEqual([...summary.distribution], [0, 0, 1, 2, 0]);

    // A drifted cache is repaired by the next refresh.
    const restaurant = await Restaurant.findOne();
    await Restaurant.updateOne({}, { $set: { "rating.count": 99 } });
    await refreshRating("restaurant", restaurant._id);
    assert.equal((await Restaurant.findOne()).rating.count, 3);

    const analytics = await request(app)
      .get("/api/v1/admin/reviews/analytics?days=7")
      .set(auth(admin.token));
    assert.equal(analytics.status, 200);
    const a = analytics.body.data;
    assert.equal(a.targets.restaurant.count, 3);
    assert.equal(a.targets.restaurant.average, 3.67);
    assert.equal(a.newReviews, 4, "removed reviews still count as written");
    assert.equal(a.daily.length, 7);
    assert.equal(a.statusCounts.removed, 1);
    assert.equal(a.moderationActions.remove, 1);
    assert.equal(a.restaurants.top[0].name, "Spice Route Kitchen");
  });

  // -- one-card rating and photos ------------------------------------------------------
  describe("rate your experience", () => {
    const PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );
    const upload = (token) =>
      request(app)
        .post("/api/v1/uploads/review-images")
        .set(auth(token))
        .attach("image", PNG, "dish.png");
    const rateOrder = (token, id, body) =>
      request(app).post(`/api/v1/orders/${id}/reviews`).set(auth(token)).send(body);

    it("rates restaurant, every dish and the rider in one submission, with photos", async () => {
      const id = await deliveredOrder(customer, ["Butter Chicken", "Garlic Naan"]);
      const photos = [];
      for (let i = 0; i < 2; i++) {
        const res = await upload(customer.token);
        assert.equal(res.status, 201, JSON.stringify(res.body));
        photos.push(res.body.data.url);
      }
      const res = await rateOrder(customer.token, id, {
        restaurant: 5,
        food: 4,
        rider: 5,
        comment: "Hot and on time",
        images: photos,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const state = res.body.data;
      assert.equal(state.restaurant.review.rating, 5);
      assert.deepEqual(state.restaurant.review.images, photos);
      assert.deepEqual(state.items.map((i) => i.review.rating), [4, 4]);
      assert.equal(state.rider.review.rating, 5);
      assert.equal(await Review.countDocuments(), 4);
      assert.equal((await FoodItem.findById(food["Garlic Naan"].id)).rating.average, 4);

      const pub = await request(app).get("/api/v1/restaurants/spice-route-kitchen/reviews");
      assert.deepEqual(pub.body.data.items[0].images, photos);

      const again = await rateOrder(customer.token, id, { rider: 1 });
      assert.equal(again.body.error.code, "DUPLICATE_REVIEW");
    });

    it("is all or nothing", async () => {
      const id = await deliveredOrder(customer, ["Butter Chicken", "Garlic Naan"]);
      await rateRestaurant(customer.token, id, 3);
      // The restaurant part is a duplicate, so neither dish nor rider ratings are saved.
      const res = await rateOrder(customer.token, id, { restaurant: 5, food: 5, rider: 5 });
      assert.equal(res.status, 409);
      assert.equal(await Review.countDocuments(), 1);
      // Food quality skips dishes already rated.
      await review(customer.token, {
        orderId: id,
        target: "food",
        foodItemId: food["Butter Chicken"].id,
        rating: 2,
      });
      const ok = await rateOrder(customer.token, id, { food: 5 });
      assert.equal(ok.status, 201);
      assert.deepEqual(ok.body.data.items.map((i) => i.review.rating), [2, 5]);
    });

    it("validates the submission and only accepts BiteBox-hosted photos", async () => {
      const id = await deliveredOrder();
      for (const body of [
        {},
        { restaurant: 6 },
        { food: 4, comment: "words need a restaurant rating" },
        { restaurant: 4, images: ["https://example.com/cat.png"] },
        { restaurant: 4, images: Array(6).fill("x") },
      ]) {
        const res = await rateOrder(customer.token, id, body);
        assert.equal(res.status, 422, JSON.stringify(body));
      }
      const single = await review(customer.token, {
        orderId: id,
        target: "rider",
        rating: 4,
        images: [(await upload(customer.token)).body.data.url],
      });
      assert.equal(single.status, 422, "no photos on delivery ratings");
      assert.equal(await Review.countDocuments(), 0);

      assert.equal((await upload(owner.token).then((r) => r.status)), 403, "customers only");
      const notImage = await request(app)
        .post("/api/v1/uploads/review-images")
        .set(auth(customer.token))
        .attach("image", Buffer.from("not an image"), "x.png");
      assert.equal(notImage.status, 415);
    });

    it("keeps earlier photos in the edit history", async () => {
      const id = await deliveredOrder();
      const first = (await upload(customer.token)).body.data.url;
      const second = (await upload(customer.token)).body.data.url;
      const r = await review(customer.token, {
        orderId: id,
        target: "restaurant",
        rating: 4,
        images: [first],
      });
      const edited = await request(app)
        .patch(`/api/v1/reviews/${r.body.data.review.id}`)
        .set(auth(customer.token))
        .send({ images: [second] });
      assert.equal(edited.status, 200);
      assert.deepEqual(edited.body.data.review.images, [second]);
      const stored = await Review.findById(r.body.data.review.id).select("+edits");
      assert.deepEqual([...stored.edits[0].images], [first]);
    });
  });

  // -- grouped by order ------------------------------------------------------------------
  it("groups reviews by order for the restaurant and the admin", async () => {
    const first = await deliveredOrder(customer, ["Butter Chicken", "Garlic Naan"]);
    await request(app)
      .post(`/api/v1/orders/${first}/reviews`)
      .set(auth(customer.token))
      .send({ restaurant: 4, food: 5, rider: 3, comment: "Good overall" });
    const second = await deliveredOrder();
    const flagged = (await rateRestaurant(customer.token, second, 1, "Bad")).body.data.review.id;
    const other = await secondCustomer();
    await request(app)
      .post(`/api/v1/reviews/${flagged}/reports`)
      .set(auth(other.token))
      .send({ reason: "spam" });

    const rows = await request(app)
      .get("/api/v1/my/restaurant/reviews/orders")
      .set(auth(owner.token));
    assert.equal(rows.status, 200);
    assert.equal(rows.body.data.items.length, 2, "one row per order");
    assert.equal(rows.body.data.pagination.total, 2);
    const row = rows.body.data.items.find((r) => r.order === first);
    assert.deepEqual(
      row.reviews.map((r) => [r.target, r.foodName]),
      [
        ["restaurant", null],
        ["food", "Butter Chicken"],
        ["food", "Garlic Naan"],
      ],
      "restaurant first, then dishes; never the rider",
    );
    assert.equal(row.unanswered, 3);
    assert.equal(row.authorName, "Asha C.");

    // Filters pick orders; the row still shows the whole order.
    const lowOnly = await request(app)
      .get("/api/v1/my/restaurant/reviews/orders?rating=5")
      .set(auth(owner.token));
    assert.equal(lowOnly.body.data.items.length, 1);
    assert.equal(lowOnly.body.data.items[0].reviews.length, 3);

    const one = await request(app)
      .get(`/api/v1/my/restaurant/reviews/orders/${first}`)
      .set(auth(owner.token));
    assert.equal(one.body.data.reviews.length, 3);
    assert.equal(one.body.data.orderNumber, row.orderNumber);
    for (const who of [customer, rider])
      assert.equal(
        (await request(app).get(`/api/v1/my/restaurant/reviews/orders/${first}`).set(auth(who.token))).status,
        403,
      );

    const queue = await request(app)
      .get("/api/v1/admin/reviews/orders?reported=true")
      .set(auth(admin.token));
    assert.equal(queue.status, 200);
    assert.equal(queue.body.data.items.length, 1);
    assert.equal(queue.body.data.items[0].order, second);
    assert.equal(queue.body.data.items[0].openReports, 1);
    assert.equal(queue.body.data.counts.reported, 1);

    const all = await request(app).get("/api/v1/admin/reviews/orders").set(auth(admin.token));
    assert.equal(all.body.data.items.length, 2);
    const detail = await request(app)
      .get(`/api/v1/admin/reviews/orders/${first}`)
      .set(auth(admin.token));
    assert.deepEqual(
      detail.body.data.reviews.map((r) => r.target),
      ["restaurant", "food", "food", "rider"],
      "the admin sees the rider review too",
    );
    assert.ok(Array.isArray(detail.body.data.reviews[0].moderationLog));
    assert.equal(
      (await request(app).get(`/api/v1/admin/reviews/orders/${first}`).set(auth(owner.token))).status,
      403,
    );
  });
});
