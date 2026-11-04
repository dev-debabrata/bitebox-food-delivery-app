import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { DISPATCH } from "../config/dispatch.js";
import { Address } from "../models/address.model.js";
import { Coupon, CouponRedemption } from "../models/coupon.model.js";
import { DeliveryPartner } from "../models/delivery-partner.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { Order, Payment } from "../models/order.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { sweep } from "../services/dispatch.service.js";
import {
  TRANSITIONS,
  canTransition,
} from "../services/order-workflow.service.js";
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
// The seeded restaurant is at [77.6412, 12.9719]. Riders are placed relative to it.
const NEAR = { latitude: 12.9729, longitude: 77.6412 }; // ~110 m away
const FARTHER = { latitude: 12.9899, longitude: 77.6412 }; // ~2 km away
const TOO_FAR = { latitude: 13.1719, longitude: 77.6412 }; // ~22 km away

describe("order state machine", () => {
  it("only allows the documented moves", () => {
    assert.ok(canTransition("pending", "confirmed", "restaurant"));
    assert.ok(canTransition("pending", "cancelled", "customer"));
    assert.ok(
      !canTransition("confirmed", "cancelled", "customer"),
      "customers cannot cancel accepted orders",
    );
    assert.ok(
      !canTransition("pending", "preparing", "restaurant"),
      "cannot skip acceptance",
    );
    assert.ok(
      !canTransition("ready_for_pickup", "assigned", "restaurant"),
      "only riders accept deliveries",
    );
    assert.ok(
      !canTransition("picked_up", "cancelled", "admin"),
      "nobody cancels food on its way",
    );
    for (const final of ["delivered", "rejected", "cancelled"]) {
      assert.deepEqual(TRANSITIONS[final], {}, `${final} is final`);
    }
  });
});

describe("order management and delivery", () => {
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
    food = Object.fromEntries((await FoodItem.find()).map((f) => [f.name, f]));
  });

  // -- helpers ---------------------------------------------------------------
  async function placeOrder({ coupon } = {}) {
    await request(app)
      .post("/api/v1/cart/items")
      .set(auth(customer.token))
      .send({ foodItemId: food["Butter Chicken"].id, quantity: 2 });
    if (coupon)
      await request(app)
        .post("/api/v1/cart/coupon")
        .set(auth(customer.token))
        .send({ code: coupon });
    const address = await Address.findOne({
      user: customer.user.id,
      isDefault: true,
    });
    const res = await request(app)
      .post("/api/v1/orders")
      .set(auth(customer.token))
      .send({ addressId: String(address._id), paymentMethod: "cod" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data.order.id;
  }
  const restaurantSet = (id, status, reason) =>
    request(app)
      .patch(`/api/v1/my/restaurant/orders/${id}/status`)
      .set(auth(owner.token))
      .send({ status, reason });
  const goOnline = (token, where = NEAR) =>
    request(app)
      .patch("/api/v1/delivery/me/availability")
      .set(auth(token))
      .send({ isOnline: true, ...where });
  const riderSet = (token, id, status) =>
    request(app)
      .patch(`/api/v1/delivery/orders/${id}/status`)
      .set(auth(token))
      .send({ status });
  const dashboard = (token) =>
    request(app).get("/api/v1/delivery/me").set(auth(token));

  async function readyOrder(opts) {
    const id = await placeOrder(opts);
    for (const status of ["confirmed", "preparing", "ready_for_pickup"])
      assert.equal((await restaurantSet(id, status)).status, 200);
    return id;
  }

  async function newRider(where) {
    const { token } = await registerUser(app, {
      role: "delivery",
      name: "Second Rider",
    });
    await request(app)
      .put("/api/v1/delivery/me/vehicle")
      .set(auth(token))
      .send({ vehicleType: "scooter", vehicleNumber: "KA 02 CC 1234" });
    if (where) await goOnline(token, where);
    return token;
  }

  // -- the full journey --------------------------------------------------------
  it("runs the whole workflow from order to delivery", async () => {
    assert.equal((await goOnline(rider.token)).status, 200);
    const id = await placeOrder();

    const accepted = await restaurantSet(id, "confirmed");
    assert.equal(accepted.body.data.order.status, "confirmed");
    assert.equal(
      accepted.body.data.order.deliveryAddress.phone,
      undefined,
      "restaurant does not see the customer's phone",
    );
    await restaurantSet(id, "preparing");
    await restaurantSet(id, "ready_for_pickup");

    // Ready -> offered to the only nearby rider, who sees the pickup but not yet the customer's phone.
    const offer = (await dashboard(rider.token)).body.data.offer;
    assert.equal(offer.id, id);
    assert.ok(offer.offerExpiresAt);
    assert.equal(offer.deliveryAddress.phone, undefined);

    const accept = await request(app)
      .post(`/api/v1/delivery/offers/${id}/accept`)
      .set(auth(rider.token));
    assert.equal(accept.status, 200);
    assert.equal(accept.body.data.activeOrder.status, "assigned");
    assert.ok(
      accept.body.data.activeOrder.deliveryAddress.phone,
      "the carrying rider gets the customer's phone",
    );

    const seen = await request(app)
      .get(`/api/v1/orders/${id}`)
      .set(auth(customer.token));
    assert.equal(seen.body.data.order.rider.name, "Ravi Rider");
    assert.equal(seen.body.data.order.rider.vehicleType, "motorbike");

    for (const status of ["picked_up", "on_the_way", "delivered"]) {
      const res = await riderSet(rider.token, id, status);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    const order = await Order.findById(id);
    assert.equal(order.status, "delivered");
    assert.equal(order.paymentStatus, "paid");
    assert.deepEqual(
      order.statusHistory.map((h) => h.status),
      [
        "pending",
        "confirmed",
        "preparing",
        "ready_for_pickup",
        "assigned",
        "picked_up",
        "on_the_way",
        "delivered",
      ],
    );
    assert.equal(
      (await Payment.findOne({ order: id })).status,
      "paid",
      "cash collected",
    );
    const profile = await DeliveryPartner.findOne({ user: rider.user.id });
    assert.equal(profile.activeOrder, null, "rider is free again");
    assert.equal(profile.completedDeliveries, 1);

    const history = await request(app)
      .get("/api/v1/delivery/orders/history")
      .set(auth(rider.token));
    assert.equal(history.body.data.items[0].id, id);
  });

  // -- restaurant --------------------------------------------------------------
  describe("restaurant", () => {
    it("enforces the transition table and treats repeats as no-ops", async () => {
      const id = await placeOrder();
      const skip = await restaurantSet(id, "ready_for_pickup");
      assert.equal(skip.status, 409);
      assert.equal(skip.body.error.code, "INVALID_TRANSITION");

      assert.equal((await restaurantSet(id, "confirmed")).status, 200);
      const again = await restaurantSet(id, "confirmed");
      assert.equal(again.status, 200, "double click is harmless");
      assert.equal(
        (await Order.findById(id)).statusHistory.length,
        2,
        "recorded once",
      );

      assert.equal(
        (await restaurantSet(id, "rejected", "Too busy")).status,
        409,
        "cannot reject after accepting",
      );
    });

    it("needs a reason to reject, and gives the coupon use back", async () => {
      const id = await placeOrder({ coupon: "WELCOME50" });
      assert.equal((await Coupon.findOne({ code: "WELCOME50" })).usedCount, 1);
      assert.equal((await restaurantSet(id, "rejected")).status, 400);

      const res = await restaurantSet(id, "rejected", "Out of chicken today");
      assert.equal(res.body.data.order.status, "rejected");
      const order = await Order.findById(id);
      assert.equal(order.cancellation.by, "restaurant");
      assert.equal(order.cancellation.reason, "Out of chicken today");
      assert.equal(order.paymentStatus, "cancelled");
      assert.equal(
        (await Coupon.findOne({ code: "WELCOME50" })).usedCount,
        0,
        "coupon use restored",
      );
      assert.equal(await CouponRedemption.countDocuments(), 0);
      assert.equal((await Payment.findOne({ order: id })).status, "cancelled");
    });

    it("only sees and changes its own restaurant's orders", async () => {
      const id = await placeOrder();
      const other = await registerUser(app, {
        role: "restaurant",
        name: "Other Owner",
      });
      await request(app)
        .post("/api/v1/my/restaurant")
        .set(auth(other.token))
        .send({
          name: "Other Place",
          cuisines: ["Chinese"],
          phone: "9111111111",
          address: {
            line1: "1 Test Street",
            city: "Bengaluru",
            state: "Karnataka",
            postalCode: "560001",
          },
          location: { latitude: 12.97, longitude: 77.6 },
          costForTwoPaise: 50000,
          openingTime: "10:00",
          closingTime: "22:00",
        });
      const res = await request(app)
        .patch(`/api/v1/my/restaurant/orders/${id}/status`)
        .set(auth(other.token))
        .send({ status: "confirmed" });
      assert.equal(res.status, 404);
      const list = await request(app)
        .get("/api/v1/my/restaurant/orders")
        .set(auth(other.token));
      assert.equal(list.body.data.items.length, 0);

      const mine = await request(app)
        .get("/api/v1/my/restaurant/orders")
        .set(auth(owner.token));
      assert.equal(mine.body.data.items.length, 1);
      assert.equal(mine.body.data.counts.pending, 1);

      // Other roles cannot use the restaurant endpoints at all.
      assert.equal(
        (
          await request(app)
            .get("/api/v1/my/restaurant/orders")
            .set(auth(customer.token))
        ).status,
        403,
      );
    });

    it("lets exactly one of two racing changes win", async () => {
      const id = await placeOrder();
      const [accept, cancel] = await Promise.all([
        restaurantSet(id, "confirmed"),
        request(app)
          .post(`/api/v1/orders/${id}/cancel`)
          .set(auth(customer.token))
          .send({}),
      ]);
      const statuses = [accept.status, cancel.status].sort();
      assert.deepEqual(statuses, [200, 409]);
      const order = await Order.findById(id);
      assert.ok(["confirmed", "cancelled"].includes(order.status));
      assert.equal(order.statusHistory.length, 2);
    });
  });

  // -- customer ----------------------------------------------------------------
  describe("customer", () => {
    it("can cancel only before the restaurant accepts", async () => {
      const first = await placeOrder();
      const cancel = await request(app)
        .post(`/api/v1/orders/${first}/cancel`)
        .set(auth(customer.token))
        .send({ reason: "Ordered by mistake" });
      assert.equal(cancel.status, 200);
      assert.equal(cancel.body.data.order.status, "cancelled");

      const second = await placeOrder();
      await restaurantSet(second, "confirmed");
      const late = await request(app)
        .post(`/api/v1/orders/${second}/cancel`)
        .set(auth(customer.token))
        .send({});
      assert.equal(late.status, 409);
    });

    it("cannot cancel or read someone else's order", async () => {
      const id = await placeOrder();
      const stranger = await registerUser(app);
      assert.equal(
        (
          await request(app)
            .post(`/api/v1/orders/${id}/cancel`)
            .set(auth(stranger.token))
            .send({})
        ).status,
        404,
      );
      assert.equal(
        (
          await request(app)
            .get(`/api/v1/orders/${id}`)
            .set(auth(stranger.token))
        ).status,
        404,
      );
    });
  });

  // -- dispatch ----------------------------------------------------------------
  describe("dispatch", () => {
    it("offers the nearest free rider, then the next one after a decline", async () => {
      const far = await newRider(FARTHER);
      await goOnline(rider.token, NEAR);
      const id = await readyOrder();

      assert.equal(
        (await dashboard(rider.token)).body.data.offer?.id,
        id,
        "nearest rider first",
      );
      assert.equal((await dashboard(far)).body.data.offer, null);

      // The far rider cannot take an order that was not offered to them.
      const steal = await request(app)
        .post(`/api/v1/delivery/offers/${id}/accept`)
        .set(auth(far));
      assert.equal(steal.status, 409);
      assert.equal(steal.body.error.code, "OFFER_UNAVAILABLE");

      assert.equal(
        (
          await request(app)
            .post(`/api/v1/delivery/offers/${id}/decline`)
            .set(auth(rider.token))
        ).status,
        200,
      );
      assert.equal(
        (await dashboard(far)).body.data.offer?.id,
        id,
        "moved to the next rider",
      );
      assert.equal(
        (await dashboard(rider.token)).body.data.offer,
        null,
        "not offered again to the decliner",
      );
    });

    it("skips riders who are too far, stale, busy or without a vehicle", async () => {
      await newRider(TOO_FAR);
      const stale = await newRider(NEAR);
      await DeliveryPartner.updateOne(
        {
          isOnline: true,
          "location.coordinates": [NEAR.longitude, NEAR.latitude],
        },
        {
          locationUpdatedAt: new Date(
            Date.now() - (DISPATCH.locationFreshMinutes + 1) * 60_000,
          ),
        },
      );
      const noVehicle = await registerUser(app, {
        role: "delivery",
        name: "No Vehicle",
      });
      assert.equal(
        (await goOnline(noVehicle.token)).status,
        400,
        "vehicle required to go online",
      );

      const id = await readyOrder();
      assert.equal(
        (await Order.findById(id)).offer?.partner,
        undefined,
        "nobody eligible",
      );
      assert.equal((await dashboard(stale)).body.data.offer, null);

      // A rider coming online picks up the waiting order straight away.
      await goOnline(rider.token, NEAR);
      assert.equal((await dashboard(rider.token)).body.data.offer?.id, id);
    });

    it("expires ignored offers, sets that rider offline and re-offers", async () => {
      const second = await newRider(FARTHER);
      await goOnline(rider.token, NEAR);
      const id = await readyOrder();

      const later = new Date(
        Date.now() + (DISPATCH.offerTimeoutSeconds + 5) * 1000,
      );
      const summary = await sweep(later);
      assert.equal(summary.expiredOffers, 1);
      const ignored = await DeliveryPartner.findOne({ user: rider.user.id });
      assert.equal(
        ignored.isOnline,
        false,
        "rider who ignored the request is set offline",
      );
      assert.equal(ignored.currentOffer, null);
      assert.equal(
        (await dashboard(second)).body.data.offer?.id,
        id,
        "offered to the next rider",
      );

      const lateAccept = await request(app)
        .post(`/api/v1/delivery/offers/${id}/accept`)
        .set(auth(rider.token));
      assert.equal(
        lateAccept.status,
        409,
        "an expired offer cannot be accepted",
      );
    });

    it("never gives one rider two orders", async () => {
      await goOnline(rider.token, NEAR);
      const first = await readyOrder();
      const second = await readyOrder();
      const profile = await DeliveryPartner.findOne({ user: rider.user.id });
      assert.equal(String(profile.currentOffer), first);
      assert.equal(
        (await Order.findById(second)).offer?.partner,
        undefined,
        "second order waits",
      );

      await request(app)
        .post(`/api/v1/delivery/offers/${first}/accept`)
        .set(auth(rider.token));
      await sweep();
      assert.equal(
        (await Order.findById(second)).offer?.partner,
        undefined,
        "busy rider is not offered more",
      );
      const offline = await request(app)
        .patch("/api/v1/delivery/me/availability")
        .set(auth(rider.token))
        .send({ isOnline: false });
      assert.equal(offline.status, 409, "cannot go offline mid-delivery");
    });

    it("only lets the carrying rider update a delivery", async () => {
      await goOnline(rider.token, NEAR);
      const id = await readyOrder();
      await request(app)
        .post(`/api/v1/delivery/offers/${id}/accept`)
        .set(auth(rider.token));
      const other = await newRider();
      assert.equal((await riderSet(other, id, "picked_up")).status, 404);
      assert.equal(
        (await riderSet(rider.token, id, "delivered")).status,
        409,
        "cannot skip pickup",
      );
      assert.equal((await riderSet(rider.token, id, "picked_up")).status, 200);
    });
  });

  // -- timeouts and admin ------------------------------------------------------
  it("auto-rejects orders the restaurant never answers", async () => {
    const id = await placeOrder();
    await sweep(
      new Date(Date.now() + (DISPATCH.restaurantResponseMinutes + 1) * 60_000),
    );
    const order = await Order.findById(id);
    assert.equal(order.status, "rejected");
    assert.equal(order.cancellation.by, "system");
  });

  describe("admin", () => {
    let admin;
    beforeEach(async () => {
      admin = await createAndLogin(app, "admin");
    });

    it("monitors, cancels with a reason and unassigns riders", async () => {
      const second = await newRider(FARTHER);
      await goOnline(rider.token, NEAR);
      const id = await readyOrder();
      await request(app)
        .post(`/api/v1/delivery/offers/${id}/accept`)
        .set(auth(rider.token));

      const list = await request(app)
        .get("/api/v1/admin/orders?status=active")
        .set(auth(admin.token));
      assert.equal(list.body.data.items[0].id, id);
      assert.equal(list.body.data.counts.assigned, 1);

      const unassign = await request(app)
        .post(`/api/v1/admin/orders/${id}/unassign`)
        .set(auth(admin.token))
        .send({ reason: "Rider's bike broke down" });
      assert.equal(unassign.status, 200);
      assert.equal(unassign.body.data.order.status, "ready_for_pickup");
      assert.equal(
        (await DeliveryPartner.findOne({ user: rider.user.id })).activeOrder,
        null,
        "first rider freed",
      );
      assert.equal(
        (await dashboard(second)).body.data.offer?.id,
        id,
        "re-offered to someone else",
      );

      assert.equal(
        (
          await request(app)
            .post(`/api/v1/admin/orders/${id}/cancel`)
            .set(auth(admin.token))
            .send({})
        ).status,
        422,
        "reason required",
      );
      const cancel = await request(app)
        .post(`/api/v1/admin/orders/${id}/cancel`)
        .set(auth(admin.token))
        .send({ reason: "Customer unreachable" });
      assert.equal(cancel.body.data.order.status, "cancelled");
      assert.equal(
        (await dashboard(second)).body.data.offer,
        null,
        "offer withdrawn",
      );
    });

    it("manages delivery partners and blocks suspending one mid-delivery", async () => {
      await goOnline(rider.token, NEAR);
      const id = await readyOrder();
      await request(app)
        .post(`/api/v1/delivery/offers/${id}/accept`)
        .set(auth(rider.token));

      const riders = await request(app)
        .get("/api/v1/admin/delivery-partners?online=true")
        .set(auth(admin.token));
      assert.equal(riders.body.data.items.length, 1);
      assert.equal(riders.body.data.items[0].activeOrder.id, id);

      const busy = await request(app)
        .patch(`/api/v1/admin/delivery-partners/${rider.user.id}/status`)
        .set(auth(admin.token))
        .send({ status: "suspended" });
      assert.equal(busy.status, 409);

      for (const status of ["picked_up", "on_the_way", "delivered"])
        await riderSet(rider.token, id, status);
      const suspend = await request(app)
        .patch(`/api/v1/admin/delivery-partners/${rider.user.id}/status`)
        .set(auth(admin.token))
        .send({ status: "suspended" });
      assert.equal(suspend.status, 200);
      assert.equal(
        (await DeliveryPartner.findOne({ user: rider.user.id })).isOnline,
        false,
      );
      assert.equal(
        (await dashboard(rider.token)).status,
        401,
        "suspended rider is signed out",
      );
    });

    it("is admin-only", async () => {
      assert.equal(
        (await request(app).get("/api/v1/admin/orders").set(auth(owner.token)))
          .status,
        403,
      );
      assert.equal(
        (
          await request(app)
            .get("/api/v1/admin/delivery-partners")
            .set(auth(rider.token))
        ).status,
        403,
      );
    });
  });
});
