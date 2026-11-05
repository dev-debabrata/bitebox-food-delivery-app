import { DISPATCH } from "../config/dispatch.js";
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
import { User } from "../models/user.model.js";
import { ApiError } from "../utils/api-error.js";
import { escapeRegex, paginationMeta } from "../utils/pagination.js";
import { dispatchSafely } from "./dispatch.service.js";
import { paymentView } from "./payments/payment.service.js";
import {
  ACTIVE_STATUSES,
  ACTORS,
  FINAL_STATUSES,
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
  const json = order.toJSON();
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
    [S.READY_FOR_PICKUP, S.ASSIGNED].includes(order.status) &&
    order.statusHistory.find((h) => h.status === S.READY_FOR_PICKUP)?.at;
  if (readyAt)
    json.pickupBy = plusMinutes(readyAt, DISPATCH.pickupWindowMinutes);
  delete json.offer;
  return json;
}

/** Rider: pickup and drop details. The customer's phone only once they carry the order. */
export function presentForRider(order, userId) {
  const json = order.toJSON();
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

const listFields =
  "orderNumber restaurant restaurantSnapshot.name restaurantSnapshot.slug items pricing.totalPaise status paymentMethod paymentStatus deliveryPartner createdAt updatedAt";

// Customer
export async function customerGet(userId, orderId) {
  const order = await Order.findOne({ _id: orderId, customer: userId });
  if (!order) throw ApiError.notFound("Order not found");
  return presentWithRider(order);
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
  return presentWithRider(order);
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

/** Accept, reject, start preparing, mark ready. "Ready" immediately looks for a rider. */
export async function restaurantSetStatus(
  ownerId,
  orderId,
  { status, reason },
) {
  const restaurant = await ownRestaurantId(ownerId);
  if (status === S.REJECTED && !reason)
    throw ApiError.badRequest("Tell the customer why the order is rejected");
  const { order, changed } = await transition(orderId, {
    to: status,
    actor: ACTORS.RESTAURANT,
    userId: ownerId,
    scope: { restaurant, submittedAt: { $ne: null } },
    reason: status === S.REJECTED ? reason : undefined,
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
  [S.ASSIGNED]: S.PICKED_UP,
  [S.PICKED_UP]: S.ON_THE_WAY,
  [S.ON_THE_WAY]: S.DELIVERED,
};

/** Picked up -> on the way -> delivered, only on the rider's own order. */
export async function riderSetStatus(userId, orderId, status) {
  if (!Object.values(RIDER_NEXT).includes(status))
    throw ApiError.badRequest("Unknown delivery status");
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
