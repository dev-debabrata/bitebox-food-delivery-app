import { DISPATCH } from "../config/dispatch.js";
import { logger } from "../config/logger.js";
import { DeliveryPartner } from "../models/delivery-partner.model.js";
import { ORDER_STATUS, Order, PAYMENT_METHODS } from "../models/order.model.js";
import { USER_STATUS } from "../models/user.model.js";
import { emitOrderUpdated } from "../sockets/events.js";
import { ApiError } from "../utils/api-error.js";
import { ACTORS, transition } from "./order-workflow.service.js";
import { startSweepLoop } from "../utils/sweep-loop.js";
import { notifyOffer } from "./order-notifications.js";

const S = ORDER_STATUS;
const DISTANCE_BUCKET_M = 500;

export async function dispatch(orderId, now = new Date()) {
  const order = await Order.findOne({
    _id: orderId,
    status: S.READY_FOR_PICKUP,
    "offer.partner": null,
  });
  if (!order?.restaurantSnapshot?.location?.coordinates) return null;

  const candidates = await DeliveryPartner.aggregate([
    {
      $geoNear: {
        near: {
          type: "Point",
          coordinates: order.restaurantSnapshot.location.coordinates,
        },
        distanceField: "distanceMeters",
        maxDistance: DISPATCH.maxPickupDistanceKm * 1000,
        spherical: true,
        query: {
          ...freeRiderFilter(now),
          user: { $nin: order.declinedBy ?? [] },
        },
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "user",
        foreignField: "_id",
        as: "account",
        pipeline: [{ $project: { status: 1 } }],
      },
    },
    { $match: { "account.status": USER_STATUS.ACTIVE } },
    {
      $addFields: {
        band: { $floor: { $divide: ["$distanceMeters", DISTANCE_BUCKET_M] } },
      },
    },
    { $sort: { band: 1, lastAssignedAt: 1, distanceMeters: 1 } },
    { $limit: 10 },
  ]);

  for (const candidate of candidates) {
    // Lock the rider first: only succeeds if they are still free.
    const locked = await DeliveryPartner.findOneAndUpdate(
      {
        _id: candidate._id,
        isOnline: true,
        activeOrder: null,
        currentOffer: null,
      },
      { $set: { currentOffer: order._id } },
    );
    if (!locked) continue;

    const expiresAt = new Date(
      now.getTime() + DISPATCH.offerTimeoutSeconds * 1000,
    );
    const offered = await Order.findOneAndUpdate(
      { _id: order._id, status: S.READY_FOR_PICKUP, "offer.partner": null },
      { $set: { offer: { partner: candidate.user, expiresAt } } },
      { returnDocument: "after" },
    );
    if (!offered) {
      // The order changed meanwhile (cancelled, or offered by a concurrent sweep): free the rider.
      await DeliveryPartner.updateOne(
        { _id: candidate._id, currentOffer: order._id },
        { $set: { currentOffer: null } },
      );
      return null;
    }
    logger.info(
      {
        orderId: order.id,
        rider: String(candidate.user),
        distanceMeters: Math.round(candidate.distanceMeters),
      },
      "Delivery offered",
    );
    emitOrderUpdated(offered);
    await notifyOffer(offered, candidate.user);
    return candidate.user;
  }
  return null;
}

/** Riders who could be offered an order right now (dispatch adds distance and declined-by checks). */
const freeRiderFilter = (now) => ({
  isOnline: true,
  activeOrder: null,
  currentOffer: null,
  locationUpdatedAt: {
    $gte: new Date(now.getTime() - DISPATCH.locationFreshMinutes * 60_000),
  },
});

/** Ready orders nobody is being offered, longest-waiting first. */
export const findWaitingOrders = (limit) =>
  Order.find({ status: S.READY_FOR_PICKUP, "offer.partner": null })
    .sort({ updatedAt: 1 })
    .select("_id")
    .limit(limit);

/** Dispatch without letting a failure break the caller (e.g. the restaurant's "ready" request). */
export async function dispatchSafely(orderId) {
  try {
    return await dispatch(orderId);
  } catch (error) {
    logger.error(
      { err: error, orderId: String(orderId) },
      "Dispatch failed; the sweep will retry",
    );
    return null;
  }
}

/** The rider accepts their current offer: the order becomes "assigned" to them. */
export async function acceptOffer(userId, orderId) {
  const now = new Date();
  let result;
  try {
    result = await transition(orderId, {
      to: S.ASSIGNED,
      actor: ACTORS.DELIVERY,
      userId,
      where: { "offer.partner": userId, "offer.expiresAt": { $gt: now } },
      update: { $set: { deliveryPartner: userId }, $unset: { offer: 1 } },
    });
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 409)
      throw offerGone();
    throw error;
  }
  // A repeat accept by the same rider is fine; anyone else is told it is gone.
  if (
    !result.changed &&
    String(result.order.deliveryPartner) !== String(userId)
  )
    throw offerGone();
  if (result.changed) {
    await DeliveryPartner.updateOne(
      { user: userId, currentOffer: result.order._id },
      {
        $set: {
          currentOffer: null,
          activeOrder: result.order._id,
          lastAssignedAt: now,
        },
      },
    );
  }
  return result.order;
}

const offerGone = () =>
  new ApiError(409, "This delivery request is no longer available", {
    code: "OFFER_UNAVAILABLE",
  });

export async function declineOffer(userId, orderId) {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: S.READY_FOR_PICKUP, "offer.partner": userId },
    { $unset: { offer: 1 }, $addToSet: { declinedBy: userId } },
  );
  if (!order) throw offerGone();
  await DeliveryPartner.updateOne(
    { user: userId, currentOffer: order._id },
    { $set: { currentOffer: null } },
  );
  if (!(await dispatchSafely(order._id)))
    emitOrderUpdated(order, { alsoNotify: [userId] });
}

export async function sweep(now = new Date()) {
  const summary = {
    expiredOffers: 0,
    dispatched: 0,
    autoRejected: 0,
    unpaidCancelled: 0,
    pickupExpired: 0,
  };

  const expired = await Order.find({
    status: S.READY_FOR_PICKUP,
    "offer.expiresAt": { $lte: now },
  })
    .select("_id offer")
    .limit(100);
  for (const order of expired) {
    const rider = order.offer.partner;
    const cleared = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: S.READY_FOR_PICKUP,
        "offer.partner": rider,
        "offer.expiresAt": { $lte: now },
      },
      { $unset: { offer: 1 }, $addToSet: { declinedBy: rider } },
      { returnDocument: "after" },
    );
    if (!cleared) continue;
    await DeliveryPartner.updateOne(
      { user: rider, currentOffer: order._id },
      { $set: { currentOffer: null, isOnline: false } },
    );
    summary.expiredOffers++;
    emitOrderUpdated(cleared, { alsoNotify: [rider] });
  }

  if (await DeliveryPartner.exists(freeRiderFilter(now))) {
    for (const order of await findWaitingOrders(50)) {
      if (await dispatchSafely(order._id)) summary.dispatched++;
    }
  }

  const minutesAgo = (m) => new Date(now.getTime() - m * 60_000);
  const timeouts = [
    // Restaurant never answered (counted from when it received the order).
    {
      filter: {
        status: S.PENDING,
        submittedAt: {
          $ne: null,
          $lte: minutesAgo(DISPATCH.restaurantResponseMinutes),
        },
      },
      to: S.REJECTED,
      reason: "The restaurant did not respond in time",
      key: "autoRejected",
    },
    // Online payment never completed.
    {
      filter: {
        status: S.PENDING,
        paymentMethod: PAYMENT_METHODS.ONLINE,
        submittedAt: null,
        createdAt: { $lte: minutesAgo(DISPATCH.paymentWindowMinutes) },
      },
      to: S.CANCELLED,
      reason: "Payment was not completed in time",
      key: "unpaidCancelled",
    },
    // Ready, but no rider picked it up in time (none found, or the assigned rider never came).
    {
      filter: {
        status: { $in: [S.READY_FOR_PICKUP, S.ASSIGNED] },
        statusHistory: {
          $elemMatch: {
            status: S.READY_FOR_PICKUP,
            at: { $lte: minutesAgo(DISPATCH.pickupWindowMinutes) },
          },
        },
      },
      to: S.CANCELLED,
      reason: "No delivery partner picked up the order in time",
      key: "pickupExpired",
    },
  ];
  for (const { filter, to, reason, key } of timeouts) {
    for (const order of await Order.find(filter).select("_id").limit(100)) {
      try {
        const { changed } = await transition(order._id, {
          to,
          actor: ACTORS.SYSTEM,
          reason,
        });
        if (changed) summary[key]++;
      } catch (error) {
        // Accepted, paid or cancelled at the same moment: nothing to do.
        if (!(error instanceof ApiError)) throw error;
      }
    }
  }
  return summary;
}

/** Runs the sweep on an interval; returns a stop function (used on shutdown). */
export const startDispatchLoop = (intervalMs = DISPATCH.sweepIntervalMs) =>
  startSweepLoop("Dispatch", () => sweep(), intervalMs, (s) => Object.values(s).some(Boolean));
