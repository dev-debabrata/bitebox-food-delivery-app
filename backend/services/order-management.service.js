import { timingSafeEqual } from "node:crypto";
import { DISPATCH } from "../config/dispatch.js";
import { env } from "../config/env.js";
import { DeliveryPartner } from "../models/delivery-partner.model.js";
import { Cart } from "../models/cart.model.js";
import {
  ORDER_STATUS,
  Order,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  Payment,
} from "../models/order.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { ROLES, USER_STATUS, User } from "../models/user.model.js";
import { haversineMeters } from "../utils/geo.js";
import { ApiError } from "../utils/api-error.js";
import { escapeRegex, paginationMeta } from "../utils/pagination.js";
import { dispatchSafely } from "./dispatch.service.js";
import { settlementFor } from "./earnings.service.js";
import { inCurrent } from "./reports.service.js";
import { notifyNewDeliveryOtp } from "./order-notifications.js";
import { paymentView, refundsOf } from "./payments/payment.service.js";
import {
  ACTIVE_STATUSES,
  ACTORS,
  FINAL_STATUSES,
  newDeliveryOtp,
  releaseRider,
  transition,
} from "./order-workflow.service.js";

const S = ORDER_STATUS;
const plusMinutes = (date, minutes) =>
  new Date(date.getTime() + minutes * 60_000);

/** The rider's public card (name, phone, vehicle), for the customer and admin. */
async function riderCard(userId) {
  if (!userId) return null;
  const [user, profile] = await Promise.all([
    User.findById(userId).select("name phone"),
    DeliveryPartner.findOne({ user: userId }).select(
      "vehicleType vehicleNumber rating.average rating.count",
    ),
  ]);
  if (!user) return null;
  return {
    id: String(user._id),
    name: user.name,
    phone: user.phone ?? null,
    vehicleType: profile?.vehicleType ?? null,
    vehicleNumber: profile?.vehicleNumber ?? null,
    rating: profile?.rating?.count
      ? { average: profile.rating.average, count: profile.rating.count }
      : null,
  };
}

/** The order without internal finance: how the money is split, and which payouts settled it. */
function orderJson(order) {
  const json = order.toJSON();
  delete json.settlement;
  delete json.payouts;
  delete json.offer;
  return json;
}

/** Customer and admin: the full order plus the rider's card and the payment's state. */
export async function presentWithRider(order) {
  const json = order.toJSON();
  const [rider, payment] = await Promise.all([
    riderCard(order.deliveryPartner),
    Payment.findOne({ order: order._id }),
  ]);
  json.rider = rider;
  json.payment = payment ? paymentView(payment) : null;
  delete json.offer;
  return json;
}

export function presentForRestaurant(order) {
  const json = orderJson(order);
  const a = json.deliveryAddress;
  json.deliveryAddress = {
    recipientName: a.recipientName,
    area: a.area,
    city: a.city,
  };
  json.riderAssigned = Boolean(order.deliveryPartner);
  // Unanswered new orders are auto-rejected at this time (the sweep's rule; shown as a countdown).
  if (order.status === S.PENDING && order.submittedAt)
    json.respondBy = plusMinutes(
      order.submittedAt,
      DISPATCH.restaurantResponseMinutes,
    );
  // Ready orders no rider collects are cancelled at this time (same sweep).
  const readyAt =
    [S.READY_FOR_PICKUP, S.ASSIGNED, S.ARRIVED_AT_RESTAURANT].includes(order.status) &&
    order.statusHistory.find((h) => h.status === S.READY_FOR_PICKUP)?.at;
  if (readyAt)
    json.pickupBy = plusMinutes(readyAt, DISPATCH.pickupWindowMinutes);
  return json;
}

/** Rider: pickup and drop details. The customer's phone only once they carry the order. */
export function presentForRider(order, userId) {
  const json = orderJson(order);
  const carrying = String(order.deliveryPartner) === String(userId);
  if (!carrying) {
    const a = json.deliveryAddress;
    json.deliveryAddress = { area: a.area, city: a.city, location: a.location };
  }
  json.offerExpiresAt = order.offer?.expiresAt ?? null;
  json.offerWindowSeconds = DISPATCH.offerTimeoutSeconds;
  delete json.offer;
  delete json.cancellation;
  return json;
}

/** Straight-line metres from the rider's last GPS fix to the restaurant (null without a fix). */
export function pickupDistanceMeters(profile, order) {
  const from = profile?.location?.coordinates;
  const to = order.restaurantSnapshot?.location?.coordinates;
  return from && to ? Math.round(haversineMeters(from, to)) : null;
}

const listFields =
  "orderNumber restaurant restaurantSnapshot.name restaurantSnapshot.slug items pricing.totalPaise status paymentMethod paymentStatus deliveryPartner createdAt updatedAt";

// Customer
export async function customerGet(userId, orderId) {
  const order = await Order.findOne({ _id: orderId, customer: userId });
  if (!order) throw ApiError.notFound("Order not found");
  return presentWithRider(order, { forCustomer: true });
}

/** Customers may cancel only while the restaurant has not accepted yet. */
export async function customerCancel(userId, orderId, reason) {
  const { order } = await transition(orderId, {
    to: S.CANCELLED,
    actor: ACTORS.CUSTOMER,
    userId,
    scope: { customer: userId },
    reason: reason || "Cancelled by customer",
  });
  return presentWithRider(order, { forCustomer: true });
}

export async function abandonUnpaid(userId, orderId) {
  const order = await Order.findOne({ _id: orderId, customer: userId });
  if (!order) throw ApiError.notFound("Order not found");
  if (
    order.paymentMethod !== PAYMENT_METHODS.ONLINE ||
    order.submittedAt ||
    order.paymentStatus === PAYMENT_STATUS.PAID
  ) {
    throw new ApiError(409, "This order is already placed", {
      code: "ORDER_PLACED",
    });
  }
  if (order.status === S.PENDING) {
    await transition(order._id, {
      to: S.CANCELLED,
      actor: ACTORS.CUSTOMER,
      userId,
      scope: { customer: userId },
      where: { submittedAt: null }, // lost the race to a payment: leave the paid order alone
      reason: "Payment not completed",
    });
  }
  const items = order.items.map((i) => ({
    foodItem: i.foodItem,
    quantity: i.quantity,
  }));
  const restored = await Cart.updateOne(
    { user: userId, "items.0": { $exists: false } },
    {
      $set: {
        restaurant: order.restaurant,
        items,
        couponCode: order.coupon?.code,
        // The coins came back to the wallet when the attempt was cancelled; ask for them again.
        coinsToRedeem: order.coins?.redeemed ?? 0,
      },
    },
    { upsert: true },
  ).then(
    (r) => r.modifiedCount + r.upsertedCount > 0,
    (err) => (err.code === 11000 ? false : Promise.reject(err)), // a non-empty cart already exists
  );
  return { restored };
}

// Restaurant
async function ownRestaurantId(ownerId) {
  const restaurant = await Restaurant.findOne({ owner: ownerId }).select("_id");
  if (!restaurant) throw ApiError.notFound("Create your restaurant first");
  return restaurant._id;
}

export async function restaurantList(
  ownerId,
  { view = "active", status },
  pagination,
) {
  const restaurant = await ownRestaurantId(ownerId);
  const statuses = view === "history" ? FINAL_STATUSES : ACTIVE_STATUSES;
  // Unpaid online orders (no submittedAt) are not the restaurant's yet.
  const filter = {
    restaurant,
    submittedAt: { $ne: null },
    status: status && statuses.includes(status) ? status : { $in: statuses },
  };

  if (view === "active") {
    const [items, counts] = await Promise.all([
      Order.find(filter).sort({ createdAt: 1 }).limit(200),
      Order.aggregate([
        {
          $match: {
            restaurant,
            submittedAt: { $ne: null },
            status: { $in: ACTIVE_STATUSES },
          },
        },
        { $group: { _id: "$status", n: { $sum: 1 } } },
      ]),
    ]);
    return {
      items: items.map(presentForRestaurant),
      counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
    };
  }

  const [items, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit),
    Order.countDocuments(filter),
  ]);
  return {
    items: items.map(presentForRestaurant),
    pagination: paginationMeta(pagination, total),
  };
}

export async function restaurantGet(ownerId, orderId) {
  const restaurant = await ownRestaurantId(ownerId);
  const order = await Order.findOne({
    _id: orderId,
    restaurant,
    submittedAt: { $ne: null },
  });
  if (!order) throw ApiError.notFound("Order not found");
  return presentForRestaurant(order);
}

/**
 * Accept (with a preparation time; the restaurant's usual one when not given), reject, start
 * preparing, mark ready. "Ready" immediately looks for a rider.
 */
export async function restaurantSetStatus(
  ownerId,
  orderId,
  { status, reason, prepMinutes },
) {
  const restaurant = await Restaurant.findOne({ owner: ownerId }).select(
    "_id avgPrepTimeMinutes",
  );
  if (!restaurant) throw ApiError.notFound("Create your restaurant first");
  if (status === S.REJECTED && !reason)
    throw ApiError.badRequest("Tell the customer why the order is rejected");
  let update = {};
  if (status === S.CONFIRMED) {
    const minutes = prepMinutes || restaurant.avgPrepTimeMinutes;
    update = {
      $set: { prepMinutes: minutes, readyBy: plusMinutes(new Date(), minutes) },
    };
  }
  const { order, changed } = await transition(orderId, {
    to: status,
    actor: ACTORS.RESTAURANT,
    userId: ownerId,
    scope: { restaurant: restaurant._id, submittedAt: { $ne: null } },
    reason: status === S.REJECTED ? reason : undefined,
    update,
  });
  // Dispatch may have changed the order (an offer was made); otherwise the returned document is current.
  if (
    changed &&
    status === S.READY_FOR_PICKUP &&
    (await dispatchSafely(order._id))
  ) {
    return presentForRestaurant(await Order.findById(order._id));
  }
  return presentForRestaurant(order);
}

// Rider
const RIDER_NEXT = {
  [S.ASSIGNED]: [S.ARRIVED_AT_RESTAURANT, S.PICKED_UP],
  [S.ARRIVED_AT_RESTAURANT]: [S.PICKED_UP],
  [S.PICKED_UP]: [S.ON_THE_WAY],
  [S.ON_THE_WAY]: [S.DELIVERED],
};
export const RIDER_STATUSES = [
  S.ARRIVED_AT_RESTAURANT,
  S.PICKED_UP,
  S.ON_THE_WAY,
  S.DELIVERED,
];

const sameCode = (a, b) =>
  typeof a === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * "Delivered" needs the code the customer got at pickup. Wrong tries are counted and capped;
 * then only support can complete the order (a new code).
 */
async function checkDeliveryOtp(userId, orderId, otp) {
  const order = await Order.findOne({
    _id: orderId,
    deliveryPartner: userId,
  }).select("status deliveryOtp deliveryOtpAttempts");
  if (!order) throw ApiError.notFound("Order not found");
  if (order.status === S.DELIVERED || !order.deliveryOtp) return; // a repeat, or no code
  const max = env.deliveryOtp.maxAttempts;
  if ((order.deliveryOtpAttempts ?? 0) >= max)
    throw new ApiError(
      409,
      "Too many wrong codes. Contact BiteBox support to complete this delivery.",
      { code: "OTP_LOCKED" },
    );
  if (otp && sameCode(otp, order.deliveryOtp)) return;
  await Order.updateOne({ _id: order._id }, { $inc: { deliveryOtpAttempts: 1 } });
  const left = max - (order.deliveryOtpAttempts ?? 0) - 1;
  throw ApiError.validation([
    {
      field: "otp",
      message: otp
        ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.`
        : "Ask the customer for their delivery code",
    },
  ]);
}

/** Arrived → picked up → on the way → delivered (with the customer's code), own orders only. */
export async function riderSetStatus(userId, orderId, status, otp) {
  if (!RIDER_STATUSES.includes(status))
    throw ApiError.badRequest("Unknown delivery status");
  if (status === S.DELIVERED) await checkDeliveryOtp(userId, orderId, otp);
  const { order } = await transition(orderId, {
    to: status,
    actor: ACTORS.DELIVERY,
    userId,
    scope: { deliveryPartner: userId },
  });
  return presentForRider(order, userId);
}

export async function riderHistory(userId, pagination) {
  const filter = {
    deliveryPartner: userId,
    status: { $in: [S.DELIVERED, S.CANCELLED] },
  };
  const [items, total] = await Promise.all([
    Order.find(filter)
      .sort({ updatedAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit),
    Order.countDocuments(filter),
  ]);
  return {
    items: items.map((o) => presentForRider(o, userId)),
    pagination: paginationMeta(pagination, total),
  };
}

// Admin
/** All orders, filterable by status (or "active") and searchable by order number. */
export async function adminList({ status, search }, pagination) {
  const filter = {};
  if (status === "active") filter.status = { $in: ACTIVE_STATUSES };
  else if (status) filter.status = status;
  if (search)
    filter.orderNumber = new RegExp(
      escapeRegex(search.trim().toUpperCase()),
      "i",
    );
  const [items, total, counts] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .select(listFields),
    Order.countDocuments(filter),
    Order.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  return {
    items,
    pagination: paginationMeta(pagination, total),
    counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
  };
}

export async function adminGet(orderId) {
  const order = await Order.findById(orderId);
  if (!order) throw ApiError.notFound("Order not found");
  const json = await presentWithRider(order);
  json.offer = order.offer?.partner
    ? {
        rider: await riderCard(order.offer.partner),
        expiresAt: order.offer.expiresAt,
      }
    : null;
  // Manual assignment is possible while the order waits for a rider.
  json.canAssign = order.status === S.READY_FOR_PICKUP;
  return json;
}

export async function adminCancel(adminId, orderId, reason) {
  const { order } = await transition(orderId, {
    to: S.CANCELLED,
    actor: ACTORS.ADMIN,
    userId: adminId,
    reason,
  });
  return adminGet(order._id);
}

/** Takes an accepted order back from its rider (e.g. they cannot reach the restaurant) and re-dispatches it. */
export async function adminUnassign(adminId, orderId, reason) {
  const before = await Order.findById(orderId).select("deliveryPartner");
  const { order, changed } = await transition(orderId, {
    to: S.READY_FOR_PICKUP,
    actor: ACTORS.ADMIN,
    userId: adminId,
    // ...and do not offer it straight back to the same rider.
    update: {
      $set: { deliveryPartner: null },
      ...(before?.deliveryPartner
        ? { $addToSet: { declinedBy: before.deliveryPartner } }
        : {}),
    },
    note: reason || "Rider unassigned by admin",
  });
  if (changed) {
    await releaseRider(order);
    await dispatchSafely(order._id);
  }
  return adminGet(order._id);
}

/**
 * Gives a ready order to a chosen rider directly (manual assignment; also how support reassigns
 * after an unassign). The rider must be active, online and free; any open offer is withdrawn.
 */
export async function adminAssign(adminId, orderId, riderId) {
  const rider = await User.findOne({
    _id: riderId,
    role: ROLES.DELIVERY,
    status: USER_STATUS.ACTIVE,
  }).select("_id");
  const profile =
    rider && (await DeliveryPartner.findOne({ user: rider._id }).select("_id"));
  if (!profile) throw ApiError.notFound("Delivery partner not found");
  const order = await Order.findById(orderId).select("status offer");
  if (!order) throw ApiError.notFound("Order not found");
  if (order.status !== S.READY_FOR_PICKUP)
    throw new ApiError(409, "Only orders waiting for a rider can be assigned", {
      code: "INVALID_TRANSITION",
    });

  const now = new Date();
  const locked = await DeliveryPartner.findOneAndUpdate(
    { _id: profile._id, isOnline: true, activeOrder: null, currentOffer: null },
    { $set: { activeOrder: order._id, lastAssignedAt: now } },
  );
  if (!locked)
    throw new ApiError(
      409,
      "This rider is offline or already busy. Choose another rider.",
      { code: "RIDER_UNAVAILABLE" },
    );
  try {
    await transition(order._id, {
      to: S.ASSIGNED,
      actor: ACTORS.ADMIN,
      userId: adminId,
      where: { status: S.READY_FOR_PICKUP },
      update: { $set: { deliveryPartner: rider._id }, $unset: { offer: "" } },
      note: "Assigned by BiteBox support",
    });
  } catch (error) {
    await DeliveryPartner.updateOne(
      { _id: profile._id, activeOrder: order._id },
      { $set: { activeOrder: null } },
    );
    throw error;
  }
  // Withdraw the open offer (and free that rider).
  if (order.offer?.partner && String(order.offer.partner) !== String(rider._id))
    await DeliveryPartner.updateOne(
      { user: order.offer.partner, currentOffer: order._id },
      { $set: { currentOffer: null } },
    );
  return adminGet(order._id);
}

/** A new delivery code for an order whose rider ran out of tries; the customer gets it. */
export async function adminResetDeliveryOtp(orderId) {
  const order = await Order.findOneAndUpdate(
    {
      _id: orderId,
      status: { $in: [S.PICKED_UP, S.ON_THE_WAY] },
      deliveryOtp: { $nin: [null, ""] },
    },
    { $set: { deliveryOtp: newDeliveryOtp(), deliveryOtpAttempts: 0 } },
    { returnDocument: "after" },
  );
  if (!order) {
    if (!(await Order.exists({ _id: orderId })))
      throw ApiError.notFound("Order not found");
    throw new ApiError(409, "This order has no delivery code to reset", {
      code: "INVALID_TRANSITION",
    });
  }
  await notifyNewDeliveryOtp(order);
  return adminGet(order._id);
}

// Timeline (GET /orders/:id/timeline)
const TIMELINE_LABEL = {
  [S.PENDING]: "Order placed",
  [S.CONFIRMED]: "Accepted by the restaurant",
  [S.REJECTED]: "Rejected by the restaurant",
  [S.PREPARING]: "Being prepared",
  [S.READY_FOR_PICKUP]: "Ready for pickup",
  [S.ASSIGNED]: "Rider assigned",
  [S.ARRIVED_AT_RESTAURANT]: "Rider at the restaurant",
  [S.PICKED_UP]: "Picked up",
  [S.ON_THE_WAY]: "On the way",
  [S.DELIVERED]: "Delivered",
  [S.CANCELLED]: "Cancelled",
};

function timeline(order) {
  return {
    order: String(order._id),
    orderNumber: order.orderNumber,
    status: order.status,
    readyBy: order.readyBy ?? null,
    events: order.statusHistory.map((h) => ({
      status: h.status,
      label: TIMELINE_LABEL[h.status] ?? h.status,
      at: h.at,
      by: h.actor ?? null,
      ...(h.note ? { note: h.note } : {}),
    })),
  };
}

export async function customerTimeline(userId, orderId) {
  const order = await Order.findOne({ _id: orderId, customer: userId });
  if (!order) throw ApiError.notFound("Order not found");
  return timeline(order);
}

export async function adminTimeline(orderId) {
  const order = await Order.findById(orderId);
  if (!order) throw ApiError.notFound("Order not found");
  return timeline(order);
}

/**
 * The partner dashboard's figures. Only orders the restaurant has received count (online orders
 * appear once paid). Sales are the food value after the coupon on delivered orders; "today" is
 * the current day in env.reportTimezone.
 */
export async function restaurantStats(ownerId) {
  const restaurant = await Restaurant.findOne({ owner: ownerId }).select("_id rating");
  if (!restaurant) throw ApiError.notFound("Create your restaurant first");
  const delivered = { $eq: ["$status", S.DELIVERED] };
  const food = {
    $subtract: ["$pricing.subtotalPaise", { $ifNull: ["$pricing.discountPaise", 0] }],
  };
  const rows = await Order.aggregate([
    { $match: { restaurant: restaurant._id, submittedAt: { $ne: null } } },
    {
      $group: {
        _id: "$status",
        n: { $sum: 1 },
        today: { $sum: { $cond: [inCurrent("$submittedAt", "day"), 1, 0] } },
        sales: { $sum: { $cond: [delivered, food, 0] } },
      },
    },
  ]);
  const count = (statuses) =>
    rows.filter((r) => statuses.includes(r._id)).reduce((n, r) => n + r.n, 0);
  const sum = (key) => rows.reduce((n, r) => n + r[key], 0);
  const completed = count([S.DELIVERED]);
  const salesPaise = sum("sales");
  return {
    totalOrders: sum("n"),
    todayOrders: sum("today"),
    pendingOrders: count(ACTIVE_STATUSES),
    completedOrders: completed,
    cancelledOrders: count([S.CANCELLED, S.REJECTED]),
    salesPaise,
    averageOrderPaise: completed ? Math.round(salesPaise / completed) : 0,
    rating: { average: restaurant.rating?.average ?? 0, count: restaurant.rating?.count ?? 0 },
  };
}
