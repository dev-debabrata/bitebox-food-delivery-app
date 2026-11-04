import { logger } from "../config/logger.js";
import { FINAL_STATUSES } from "../models/order.model.js";

export const rooms = Object.freeze({
  user: (id) => `user:${id}`,
  restaurant: (id) => `restaurant:${id}`,
  order: (id) => `order:${id}`,
  admins: "admins",
});

let io = null;

export function setRealtimeServer(server) {
  io = server;
}

export function emitOrderUpdated(order, { alsoNotify = [] } = {}) {
  if (!io || !order) return;
  try {
    const payload = {
      id: String(order._id),
      orderNumber: order.orderNumber,
      status: order.status,
      updatedAt: order.updatedAt,
    };
    const targets = new Set([
      rooms.user(order.customer),
      rooms.restaurant(order.restaurant),
      rooms.admins,
    ]);
    for (const rider of [
      order.deliveryPartner,
      order.offer?.partner,
      ...alsoNotify,
    ]) {
      if (rider) targets.add(rooms.user(rider));
    }
    io.to([...targets]).emit("order:updated", payload);
    if (FINAL_STATUSES.includes(order.status))
      io.in(rooms.order(order._id)).socketsLeave(rooms.order(order._id));
  } catch (error) {
    logger.error({ err: error }, "Realtime emit failed");
  }
}

export function emitToUsers(userIds, event, payload) {
  if (!io) return;
  const targets = [
    ...new Set(userIds.filter(Boolean).map((id) => rooms.user(id))),
  ];
  if (targets.length) io.to(targets).emit(event, payload);
}
