import { logger } from "../config/logger.js";
import { Coupon, CouponRedemption } from "../models/coupon.model.js";
import { DeliveryPartner } from "../models/delivery-partner.model.js";
import { ACTIVE_STATUSES, FINAL_STATUSES, ORDER_STATUS, Order, PAYMENT_METHODS, PAYMENT_STATUS, Payment } from "../models/order.model.js";
import { emitOrderUpdated } from "../sockets/events.js";
import { ApiError } from "../utils/api-error.js";
import { settlementFor } from "./earnings.service.js";
import { notifyStatusChange } from "./order-notifications.js";
import { settleCancelledPayment } from "./payments/payment.service.js";

const S = ORDER_STATUS;

/** Who may move an order: the three panels, plus "system" for automatic timeouts. */
export const ACTORS = Object.freeze({
  CUSTOMER: "customer",
  RESTAURANT: "restaurant",
  DELIVERY: "delivery",
  ADMIN: "admin",
  SYSTEM: "system",
});
const A = ACTORS;

/**
 * The order state machine: TRANSITIONS[from][to] lists who may make that move.
 * Anything not listed is refused. Rules of thumb:
 * - customers may cancel only until the restaurant accepts;
 * - nobody cancels once the food has been picked up;
 * - "assigned" means a rider has accepted the delivery (offers happen while ready_for_pickup);
 * - an admin can take a stuck order back from its rider (assigned -> ready_for_pickup);
 * - the system cancels an order no rider picks up in time (DISPATCH.pickupWindowMinutes).
 */
export const TRANSITIONS = Object.freeze({
  [S.PENDING]: { [S.CONFIRMED]: [A.RESTAURANT], [S.REJECTED]: [A.RESTAURANT, A.SYSTEM], [S.CANCELLED]: [A.CUSTOMER, A.ADMIN, A.SYSTEM] },
  [S.CONFIRMED]: { [S.PREPARING]: [A.RESTAURANT], [S.CANCELLED]: [A.ADMIN] },
  [S.PREPARING]: { [S.READY_FOR_PICKUP]: [A.RESTAURANT], [S.CANCELLED]: [A.ADMIN] },
  [S.READY_FOR_PICKUP]: { [S.ASSIGNED]: [A.DELIVERY], [S.CANCELLED]: [A.ADMIN, A.SYSTEM] },
  [S.ASSIGNED]: { [S.PICKED_UP]: [A.DELIVERY], [S.READY_FOR_PICKUP]: [A.ADMIN], [S.CANCELLED]: [A.ADMIN, A.SYSTEM] },
  [S.PICKED_UP]: { [S.ON_THE_WAY]: [A.DELIVERY] },
  [S.ON_THE_WAY]: { [S.DELIVERED]: [A.DELIVERY] },
  [S.DELIVERED]: {},
  [S.REJECTED]: {},
  [S.CANCELLED]: {},
});

export { ACTIVE_STATUSES, FINAL_STATUSES };

export const canTransition = (from, to, actor) => Boolean(TRANSITIONS[from]?.[to]?.includes(actor));

const LABEL = {
  [S.PENDING]: "waiting for the restaurant",
  [S.CONFIRMED]: "confirmed",
  [S.REJECTED]: "rejected",
  [S.PREPARING]: "being prepared",
  [S.READY_FOR_PICKUP]: "ready for pickup",
  [S.ASSIGNED]: "assigned to a rider",
  [S.PICKED_UP]: "picked up",
  [S.ON_THE_WAY]: "on the way",
  [S.DELIVERED]: "delivered",
  [S.CANCELLED]: "cancelled",
};

const conflict = (message, code) => new ApiError(409, message, { code });

/**
 * Moves an order from its current status to `to`, if the transition table allows it for `actor`.
 *
 * - `scope` limits which orders the actor may touch (e.g. { restaurant: id }); others get 404.
 * - The write is conditional on the status we read, so concurrent requests cannot both win:
 *   the loser gets 409 ORDER_CHANGED and the order is left as the winner set it.
 * - Repeating a move the order has already made (double click, retry) returns it unchanged.
 * - `where` adds extra conditions to the write (e.g. "this rider holds an unexpired offer");
 *   `update` adds extra $set/$unset/$addToSet fields.
 */
export async function transition(orderId, { to, actor, userId = null, scope = {}, where = {}, update = {}, note, reason }) {
  const order = await Order.findOne({ _id: orderId, ...scope });
  if (!order) throw ApiError.notFound("Order not found");

  if (order.status === to) return { order, changed: false };
  if (!canTransition(order.status, to, actor)) {
    throw conflict(`This order is ${LABEL[order.status]} and cannot be ${LABEL[to]} now`, "INVALID_TRANSITION");
  }

  const now = new Date();
  const set = { status: to, ...update.$set };
  if (to === S.REJECTED || to === S.CANCELLED) {
    // Payment is closed or refunded afterwards (settleCancelledPayment).
    set.cancellation = { by: actor, reason: reason || undefined, at: now };
  }
  if (to === S.DELIVERED) {
    set.paymentStatus = PAYMENT_STATUS.PAID; // cash collected on delivery (online orders are already paid)
    set.settlement = { ...settlementFor(order), at: now };
  }

  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: order.status, ...scope, ...where },
    {
      $set: set,
      ...(update.$unset ? { $unset: update.$unset } : {}),
      ...(update.$addToSet ? { $addToSet: update.$addToSet } : {}),
      $push: { statusHistory: { status: to, at: now, by: userId, note: note || reason || undefined } },
    },
    { returnDocument: "after" },
  );
  if (!updated) {
    const current = await Order.findById(order._id).select("status");
    if (current?.status === to) return { order: await Order.findById(order._id), changed: false };
    throw conflict("This order was just updated by someone else. Refresh to see its latest status.", "ORDER_CHANGED");
  }

  await afterTransition(updated);
  emitOrderUpdated(updated, { alsoNotify: [order.offer?.partner, order.deliveryPartner] });
  await notifyStatusChange(updated, actor, order);
  logger.info({ orderId: updated.id, from: order.status, to, actor }, "Order status changed");
  return { order: updated, changed: true };
}

/**
 * Follow-up writes for a status change. Each one is idempotent and conditional, so
 * a retry after a crash cannot double-apply it (no multi-document transaction needed).
 */
async function afterTransition(order) {
  const tasks = [];
  if (order.status === S.REJECTED || order.status === S.CANCELLED) {
    tasks.push(releaseCoupon(order), settleCancelledPayment(order), releaseRider(order));
  }
  if (order.status === S.DELIVERED) {
    tasks.push(
      Payment.updateOne(
        { order: order._id, method: PAYMENT_METHODS.COD, status: PAYMENT_STATUS.PENDING },
        { $set: { status: PAYMENT_STATUS.PAID, paidAt: new Date() } },
      ),
      DeliveryPartner.updateOne(
        { user: order.deliveryPartner, activeOrder: order._id },
        { $set: { activeOrder: null }, $inc: { completedDeliveries: 1 } },
      ),
    );
  }
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") logger.error({ err: r.reason, orderId: order.id }, "Order follow-up step failed");
  }
}

/** A rejected/cancelled order gives its coupon use back (once: the redemption record is the token). */
async function releaseCoupon(order) {
  if (!order.coupon?.code) return;
  const redemption = await CouponRedemption.findOneAndDelete({ order: order._id });
  if (redemption) await Coupon.updateOne({ _id: redemption.coupon, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
}

/** Frees whichever rider was offered or carrying this order. */
export async function releaseRider(order) {
  await Promise.all([
    DeliveryPartner.updateMany({ currentOffer: order._id }, { $set: { currentOffer: null } }),
    DeliveryPartner.updateMany({ activeOrder: order._id }, { $set: { activeOrder: null } }),
  ]);
}
