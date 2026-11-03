import { logger } from "../config/logger.js";
import { FINAL_STATUSES } from "../models/order.model.js";

/** Room names, always built on the server from verified ids. */
export const rooms = Object.freeze({
  user: (id) => `user:${id}`,
  restaurant: (id) => `restaurant:${id}`,
  /** Live tracking of one order; joined only after a server-side permission check. */
  order: (id) => `order:${id}`,
  admins: "admins",
});

let io = null;

/** Set once at startup (null in tests that do not start Socket.IO, which makes emits no-ops). */
export function setRealtimeServer(server) {
  io = server;
}

/**
 * Tells everyone involved that an order changed: its customer, its restaurant,
 * the rider carrying it or being offered it, and admins.
 * Payload: { id, orderNumber, status, updatedAt } (details are re-read over REST).
 */
export function emitOrderUpdated(order, { alsoNotify = [] } = {}) {
  if (!io || !order) return;
  try {
    const payload = {
      id: String(order._id),
      orderNumber: order.orderNumber,
      status: order.status,
      updatedAt: order.updatedAt,
    };
    const targets = new Set([rooms.user(order.customer), rooms.restaurant(order.restaurant), rooms.admins]);
    // Riders carrying or being offered it, plus any who just lost it (declined, unassigned, expired).
    for (const rider of [order.deliveryPartner, order.offer?.partner, ...alsoNotify]) {
      if (rider) targets.add(rooms.user(rider));
    }
    io.to([...targets]).emit("order:updated", payload);
    // A finished order is no longer tracked: stop sharing the rider's location with its viewers.
    if (FINAL_STATUSES.includes(order.status)) io.in(rooms.order(order._id)).socketsLeave(rooms.order(order._id));
  } catch (error) {
    // Live updates are best-effort; clients also refresh on their own.
    logger.error({ err: error }, "Realtime emit failed");
  }
}

/** Pushes an event to specific users' rooms (e.g. a new in-app notification). */
export function emitToUsers(userIds, event, payload) {
  if (!io) return;
  const targets = [...new Set(userIds.filter(Boolean).map((id) => rooms.user(id)))];
  if (targets.length) io.to(targets).emit(event, payload);
}
