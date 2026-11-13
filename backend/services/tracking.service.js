import { env } from "../config/env.js";
import { PERMISSIONS, hasPermission } from "../config/permissions.js";
import { DeliveryPartner } from "../models/delivery-partner.model.js";
import { ORDER_STATUS, Order, TRACKED_STATUSES } from "../models/order.model.js";
import { notifyApproaching } from "./order-notifications.js";
import { TrackingPoint } from "../models/tracking-point.model.js";
import { ROLES } from "../models/user.model.js";
import { ApiError } from "../utils/api-error.js";
import { fromPoint, haversineMeters, toPoint } from "../utils/geo.js";

/** The newest points of a delivery sent to the map. */
const PATH_LIMIT = 200;

/** Stores a fix for the delivery unless this rider stored one within the sample interval. */
export async function record(riderId, orderId, { latitude, longitude, accuracy = null }, at) {
  const recent = new Date(at.getTime() - env.tracking.sampleSeconds * 1000);
  if (await TrackingPoint.exists({ rider: riderId, recordedAt: { $gt: recent } })) return false;
  await TrackingPoint.create({
    rider: riderId,
    order: orderId,
    location: toPoint({ latitude, longitude }),
    accuracy,
    recordedAt: at,
  });
  return true;
}

/** A fix of a rider carrying an order: store it (sampled) and tell the customer when close. */
export async function onPosition(riderId, orderId, fix, at) {
  await record(riderId, orderId, fix, at);
  await notifyIfApproaching(orderId, fix, at);
}

/** Once per order: the rider on the way is within env.notifications.approachMeters of the customer. */
export async function notifyIfApproaching(orderId, { latitude, longitude }, at) {
  const order = await Order.findOne({
    _id: orderId,
    status: ORDER_STATUS.ON_THE_WAY,
    approachNotifiedAt: null,
  });
  const home = order?.deliveryAddress?.location?.coordinates;
  if (!home) return false;
  const meters = haversineMeters([longitude, latitude], home);
  if (meters > env.notifications.approachMeters) return false;
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, approachNotifiedAt: null },
    { $set: { approachNotifiedAt: at } },
    { returnDocument: "after" },
  );
  if (claimed) await notifyApproaching(claimed);
  return Boolean(claimed);
}

/** The order this rider is carrying in a tracked status (assigned → on the way), if any. */
export async function trackedOrderId(riderId) {
  const order = await Order.findOne({
    deliveryPartner: riderId,
    status: { $in: TRACKED_STATUSES },
  }).select("_id");
  return order?._id ?? null;
}

const canView = (user, order) =>
  hasPermission(user.role, PERMISSIONS.ORDERS_VIEW) ||
  (user.role === ROLES.CUSTOMER && String(order.customer) === String(user._id)) ||
  (user.role === ROLES.DELIVERY && String(order.deliveryPartner) === String(user._id));

/**
 * GET /tracking/orders/:id: the rider's last position (and whether it is stale) plus the
 * delivery's recent path, so the map can restore its state after reconnecting.
 */
export async function orderTracking(user, orderId, now = new Date()) {
  const order = await Order.findById(orderId).select("customer deliveryPartner status");
  if (!order || !canView(user, order)) throw ApiError.notFound("Order not found");
  const tracking = TRACKED_STATUSES.includes(order.status) && Boolean(order.deliveryPartner);
  const [profile, points] = tracking
    ? await Promise.all([
        DeliveryPartner.findOne({ user: order.deliveryPartner })
          .select("location locationUpdatedAt locationAccuracy")
          .lean(),
        TrackingPoint.find({ order: order._id })
          .sort({ recordedAt: -1 })
          .limit(PATH_LIMIT)
          .select("location")
          .lean(),
      ])
    : [null, []];
  const at = profile?.location?.coordinates && profile.locationUpdatedAt;
  const ageSeconds = at ? Math.max(0, Math.floor((now - at) / 1000)) : null;
  const lastPoint = at
    ? { ...fromPoint(profile.location), accuracy: profile.locationAccuracy ?? null, at }
    : null;
  // Oldest first, as [latitude, longitude] (GeoJSON stores [longitude, latitude]).
  const recentPath = points.reverse().map(({ location: { coordinates: [lng, lat] } }) => [lat, lng]);
  return {
    orderId: String(order._id),
    status: order.status,
    tracking,
    lastPoint,
    ageSeconds,
    stale: ageSeconds !== null && ageSeconds > env.tracking.staleSeconds,
    recentPath,
  };
}
