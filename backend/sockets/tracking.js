import mongoose from "mongoose";
import { logger } from "../config/logger.js";
import { DeliveryPartner } from "../models/delivery-partner.model.js";
import {
  ORDER_STATUS,
  Order,
  TRACKED_STATUSES,
} from "../models/order.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { ROLES } from "../models/user.model.js";
import { fromPoint, haversineMeters, toPoint } from "../utils/geo.js";
import { rooms } from "./events.js";

const S = ORDER_STATUS;

export const LIMITS = Object.freeze({
  maxAccuracyMeters: 1000,
  maxSpeedMps: 70,
  burst: 5,
  refillPerSecond: 1,
  persistEveryMs: 5000,
  recheckEveryMs: 5000,
});

const ack = (callback, value) =>
  typeof callback === "function" && callback(value);
const isId = (v) => typeof v === "string" && mongoose.isValidObjectId(v);

async function canTrack(user, order) {
  if (user.role === ROLES.ADMIN) return true;
  if (user.role === ROLES.CUSTOMER) return String(order.customer) === user.id;
  if (user.role === ROLES.DELIVERY)
    return String(order.deliveryPartner) === user.id;
  if (user.role === ROLES.RESTAURANT)
    return Boolean(
      await Restaurant.exists({ _id: order.restaurant, owner: user.id }),
    );
  return false;
}

const locationPayload = (orderId, profile) => ({
  orderId: String(orderId),
  ...fromPoint(profile.location),
  accuracy: profile.locationAccuracy ?? null,
  at: profile.locationUpdatedAt,
});

export function registerTracking(io, socket) {
  const user = socket.data.user;

  socket.on("track:join", async (body, callback) => {
    try {
      const orderId = body?.orderId;
      if (!isId(orderId))
        return ack(callback, { ok: false, error: "INVALID_ORDER" });
      const order = await Order.findById(orderId).select(
        "customer restaurant deliveryPartner status",
      );
      if (!order || !(await canTrack(user, order)))
        return ack(callback, { ok: false, error: "NOT_FOUND" });
      if (
        !TRACKED_STATUSES.includes(order.status) &&
        order.status !== S.READY_FOR_PICKUP
      ) {
        return ack(callback, { ok: true, location: null, tracking: false });
      }
      await socket.join(rooms.order(order._id));
      let location = null;
      if (TRACKED_STATUSES.includes(order.status) && order.deliveryPartner) {
        const profile = await DeliveryPartner.findOne({
          user: order.deliveryPartner,
        }).select("location locationUpdatedAt locationAccuracy");
        if (profile?.location?.coordinates)
          location = locationPayload(order._id, profile);
      }
      ack(callback, { ok: true, location, tracking: true });
    } catch (error) {
      logger.error({ err: error }, "track:join failed");
      ack(callback, { ok: false, error: "SERVER_ERROR" });
    }
  });

  socket.on("track:leave", async (body, callback) => {
    if (isId(body?.orderId)) await socket.leave(rooms.order(body.orderId));
    ack(callback, { ok: true });
  });

  if (user.role !== ROLES.DELIVERY) return;

  let tokens = LIMITS.burst;
  let refilledAt = Date.now();
  let last = null; // { latitude, longitude, at }
  let persistedAt = 0;
  let state = null;
  let checkedAt = 0;
  async function riderState(now) {
    if (state && now - checkedAt < LIMITS.recheckEveryMs) return state;
    const [profile, order] = await Promise.all([
      DeliveryPartner.findOne({ user: user.id }).select("isOnline"),
      Order.findOne({
        deliveryPartner: user.id,
        status: { $in: TRACKED_STATUSES },
      }).select("_id"),
    ]);
    checkedAt = now;
    state = {
      online: Boolean(profile?.isOnline),
      trackedOrderId: order ? String(order._id) : null,
    };
    return state;
  }

  socket.on("rider:location", async (body, callback) => {
    try {
      const now = Date.now();
      tokens = Math.min(
        LIMITS.burst,
        tokens + ((now - refilledAt) / 1000) * LIMITS.refillPerSecond,
      );
      refilledAt = now;
      if (tokens < 1)
        return ack(callback, { ok: false, error: "RATE_LIMITED" });
      tokens -= 1;

      const latitude = Number(body?.latitude);
      const longitude = Number(body?.longitude);
      const accuracy =
        body?.accuracy === undefined || body?.accuracy === null
          ? null
          : Number(body.accuracy);
      const valid =
        Number.isFinite(latitude) &&
        latitude >= -90 &&
        latitude <= 90 &&
        Number.isFinite(longitude) &&
        longitude >= -180 &&
        longitude <= 180 &&
        (accuracy === null || (Number.isFinite(accuracy) && accuracy >= 0));
      if (!valid)
        return ack(callback, { ok: false, error: "INVALID_LOCATION" });
      if (accuracy !== null && accuracy > LIMITS.maxAccuracyMeters)
        return ack(callback, { ok: false, error: "IMPRECISE" });
      if (last) {
        const seconds = Math.max(1, (now - last.at) / 1000);
        const meters = haversineMeters(
          [last.longitude, last.latitude],
          [longitude, latitude],
        );
        if (meters / seconds > LIMITS.maxSpeedMps)
          return ack(callback, { ok: false, error: "IMPLAUSIBLE" });
      }
      last = { latitude, longitude, at: now };

      const { online, trackedOrderId } = await riderState(now);
      if (!online) return ack(callback, { ok: false, error: "OFFLINE" });

      const at = new Date(now);
      if (now - persistedAt >= LIMITS.persistEveryMs) {
        persistedAt = now;
        await DeliveryPartner.updateOne(
          { user: user.id },
          {
            $set: {
              location: toPoint({ latitude, longitude }),
              locationUpdatedAt: at,
              locationAccuracy: accuracy ?? undefined,
            },
          },
        );
      }

      if (trackedOrderId) {
        io.to(rooms.order(trackedOrderId)).emit("order:location", {
          orderId: trackedOrderId,
          latitude,
          longitude,
          accuracy,
          at,
        });
      }
      ack(callback, { ok: true });
    } catch (error) {
      logger.error({ err: error }, "rider:location failed");
      ack(callback, { ok: false, error: "SERVER_ERROR" });
    }
  });
}
