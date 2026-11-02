import { DISPATCH } from "../config/dispatch.js";
import { logger } from "../config/logger.js";
import { DeliveryPartner } from "../models/delivery-partner.model.js";
import { ORDER_STATUS, Order } from "../models/order.model.js";
import { USER_STATUS } from "../models/user.model.js";
import { emitOrderUpdated } from "../sockets/events.js";
import { ApiError } from "../utils/api-error.js";
import { ACTORS, transition } from "./order-workflow.service.js";

const S = ORDER_STATUS;
// Riders this close to each other count as equally near; the longest-waiting one goes first.
const DISTANCE_BUCKET_M = 500;

/**
 * Assignment strategy (deterministic, so it is testable and fair):
 * 1. Eligible riders: online, active account, not carrying or being offered another order,
 *    location reported in the last DISPATCH.locationFreshMinutes, within
 *    DISPATCH.maxPickupDistanceKm of the restaurant (straight line), and not one who
 *    already declined or ignored this order.
 * 2. Nearest first, in 500 m bands; within a band, whoever was assigned least recently.
 * 3. The order is offered to one rider at a time for DISPATCH.offerTimeoutSeconds.
 *
 * Returns the offered rider's user id, or null when nobody is available (the sweep retries).
 */
export async function dispatch(orderId, now = new Date()) {
  const order = await Order.findOne({ _id: orderId, status: S.READY_FOR_PICKUP, "offer.partner": null });
  if (!order?.restaurantSnapshot?.location?.coordinates) return null;

  const candidates = await DeliveryPartner.aggregate([
    {
      $geoNear: {
        near: { type: "Point", coordinates: order.restaurantSnapshot.location.coordinates },
        distanceField: "distanceMeters",
        maxDistance: DISPATCH.maxPickupDistanceKm * 1000,
        spherical: true,
        query: {
          isOnline: true,
          activeOrder: null,
          currentOffer: null,
          locationUpdatedAt: { $gte: new Date(now.getTime() - DISPATCH.locationFreshMinutes * 60_000) },
          user: { $nin: order.declinedBy ?? [] },
        },
      },
    },
    { $lookup: { from: "users", localField: "user", foreignField: "_id", as: "account", pipeline: [{ $project: { status: 1 } }] } },
    { $match: { "account.status": USER_STATUS.ACTIVE } },
    { $addFields: { band: { $floor: { $divide: ["$distanceMeters", DISTANCE_BUCKET_M] } } } },
    { $sort: { band: 1, lastAssignedAt: 1, distanceMeters: 1 } },
    { $limit: 10 },
  ]);

  for (const candidate of candidates) {
    // Lock the rider first: only succeeds if they are still free.
    const locked = await DeliveryPartner.findOneAndUpdate(
      { _id: candidate._id, isOnline: true, activeOrder: null, currentOffer: null },
      { $set: { currentOffer: order._id } },
    );
    if (!locked) continue;

    const expiresAt = new Date(now.getTime() + DISPATCH.offerTimeoutSeconds * 1000);
    const offered = await Order.findOneAndUpdate(
      { _id: order._id, status: S.READY_FOR_PICKUP, "offer.partner": null },
      { $set: { offer: { partner: candidate.user, expiresAt } } },
      { returnDocument: "after" },
    );
    if (!offered) {
      // The order changed meanwhile (cancelled, or offered by a concurrent sweep): free the rider.
      await DeliveryPartner.updateOne({ _id: candidate._id, currentOffer: order._id }, { $set: { currentOffer: null } });
      return null;
    }
    logger.info({ orderId: order.id, rider: String(candidate.user), distanceMeters: Math.round(candidate.distanceMeters) }, "Delivery offered");
    emitOrderUpdated(offered);
    return candidate.user;
  }
  return null;
}

/** Dispatch without letting a failure break the caller (e.g. the restaurant's "ready" request). */
export async function dispatchSafely(orderId) {
  try {
    return await dispatch(orderId);
  } catch (error) {
    logger.error({ err: error, orderId: String(orderId) }, "Dispatch failed; the sweep will retry");
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
    if (error instanceof ApiError && error.statusCode === 409) throw offerGone();
    throw error;
  }
  // A repeat accept by the same rider is fine; anyone else is told it is gone.
  if (!result.changed && String(result.order.deliveryPartner) !== String(userId)) throw offerGone();
  if (result.changed) {
    await DeliveryPartner.updateOne(
      { user: userId, currentOffer: result.order._id },
      { $set: { currentOffer: null, activeOrder: result.order._id, lastAssignedAt: now } },
    );
  }
  return result.order;
}

const offerGone = () => new ApiError(409, "This delivery request is no longer available", { code: "OFFER_UNAVAILABLE" });

/** The rider turns the offer down; it goes to the next rider straight away. */
export async function declineOffer(userId, orderId) {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: S.READY_FOR_PICKUP, "offer.partner": userId },
    { $unset: { offer: 1 }, $addToSet: { declinedBy: userId } },
  );
  if (!order) throw offerGone();
  await DeliveryPartner.updateOne({ user: userId, currentOffer: order._id }, { $set: { currentOffer: null } });
  // Next rider (emits if offered); otherwise tell everyone the offer is gone.
  if (!(await dispatchSafely(order._id))) emitOrderUpdated(order, { alsoNotify: [userId] });
}

/**
 * Periodic housekeeping (also safe to call by hand):
 * - expired offers move on; the rider who ignored one is set offline (probably away);
 * - ready orders without an offer are dispatched again (e.g. a rider just came online);
 * - restaurants that never answered a new order auto-reject it.
 */
export async function sweep(now = new Date()) {
  const summary = { expiredOffers: 0, dispatched: 0, autoRejected: 0 };

  const expired = await Order.find({ status: S.READY_FOR_PICKUP, "offer.expiresAt": { $lte: now } }).select("_id offer").limit(100);
  for (const order of expired) {
    const rider = order.offer.partner;
    const cleared = await Order.updateOne(
      { _id: order._id, status: S.READY_FOR_PICKUP, "offer.partner": rider, "offer.expiresAt": { $lte: now } },
      { $unset: { offer: 1 }, $addToSet: { declinedBy: rider } },
    );
    if (!cleared.modifiedCount) continue;
    await DeliveryPartner.updateOne({ user: rider, currentOffer: order._id }, { $set: { currentOffer: null, isOnline: false } });
    summary.expiredOffers++;
    emitOrderUpdated(await Order.findById(order._id), { alsoNotify: [rider] });
  }

  const waiting = await Order.find({ status: S.READY_FOR_PICKUP, "offer.partner": null }).sort({ updatedAt: 1 }).select("_id").limit(50);
  for (const order of waiting) {
    if (await dispatchSafely(order._id)) summary.dispatched++;
  }

  const stale = await Order.find({
    status: S.PENDING,
    createdAt: { $lte: new Date(now.getTime() - DISPATCH.restaurantResponseMinutes * 60_000) },
  })
    .select("_id")
    .limit(100);
  for (const order of stale) {
    try {
      const { changed } = await transition(order._id, {
        to: S.REJECTED,
        actor: ACTORS.SYSTEM,
        reason: "The restaurant did not respond in time",
      });
      if (changed) summary.autoRejected++;
    } catch (error) {
      // Accepted or cancelled at the same moment: nothing to do.
      if (!(error instanceof ApiError)) throw error;
    }
  }
  return summary;
}

/** Runs the sweep on an interval; returns a stop function (used on shutdown). */
export function startDispatchLoop(intervalMs = DISPATCH.sweepIntervalMs) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // never overlap two sweeps
    running = true;
    try {
      const summary = await sweep();
      if (summary.expiredOffers || summary.dispatched || summary.autoRejected) logger.info(summary, "Dispatch sweep");
    } catch (error) {
      logger.error({ err: error }, "Dispatch sweep failed");
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
