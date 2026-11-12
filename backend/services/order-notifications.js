import { PERMISSIONS } from "../config/permissions.js";
import { ORDER_STATUS } from "../models/order.model.js";
import { emitOrderUpdated } from "../sockets/events.js";
import {
  notify,
  notifyAdmins,
  restaurantOwner,
} from "./notification.service.js";

const S = ORDER_STATUS;
const ref = (order) => `Order ${order.orderNumber}`;
export const rupees = (paise) => `₹${(paise / 100).toFixed(2).replace(/\.00$/, "")}`;
const dishes = (order) =>
  `${order.items.length} dish${order.items.length === 1 ? "" : "es"}`;

const toCustomer = (order, title, body, type = `order.${order.status}`) =>
  notify(order.customer, {
    type,
    title,
    body,
    link: `/orders/${order._id}`,
    order: order._id,
  });
const toRestaurant = async (
  order,
  title,
  body,
  type = `order.${order.status}`,
) =>
  notify(await restaurantOwner(order.restaurant), {
    type,
    title,
    body,
    link: "/restaurant/orders",
    order: order._id,
  });
const toRider = (riderId, order, title, body, type = `order.${order.status}`) =>
  notify(riderId, { type, title, body, link: "/delivery", order: order._id });
const toAdmins = (
  order,
  title,
  body,
  { type = `order.${order.status}`, link = "/admin/orders" } = {},
) =>
  notifyAdmins(
    { type, title, body, link, order: order._id },
    PERMISSIONS.ORDERS_MANAGE,
  );

/** The order has just reached the restaurant (cash: when placed; online: once paid). */
export async function notifyNewOrder(order, how) {
  emitOrderUpdated(order); // the restaurant's board lights up
  const summary = `${dishes(order)} · ${rupees(order.pricing.totalPaise)} · ${how}`;
  await Promise.all([
    toRestaurant(order, `New order ${order.orderNumber}`, summary, "order.new"),
    toCustomer(
      order,
      `${ref(order)} placed`,
      `${order.restaurantSnapshot.name} will confirm it shortly.`,
      "order.placed",
    ),
    toAdmins(
      order,
      `New order ${order.orderNumber}`,
      `${order.restaurantSnapshot.name} · ${summary}`,
      { type: "order.new" },
    ),
  ]);
}

/** A rider has been offered a delivery (they have a short time to accept). */
export const notifyOffer = (order, riderId) =>
  toRider(
    riderId,
    order,
    "New delivery request",
    `${order.restaurantSnapshot.name} → ${order.deliveryAddress.area || order.deliveryAddress.city}. Accept it soon.`,
    "order.offer",
  );

/** A paid online order was refunded (or the refund failed and needs an admin). */
export async function notifyRefund(order, amountPaise, ok) {
  if (!ok) {
    return toAdmins(
      order,
      `Refund failed for ${order.orderNumber}`,
      `${rupees(amountPaise)} could not be refunded. Retry it from Payments.`,
      {
        type: "payment.refund_failed",
        link: "/admin/payments",
      },
    );
  }
  await Promise.all([
    toCustomer(
      order,
      `Refund of ${rupees(amountPaise)} processed`,
      `For ${ref(order)}. It reaches your account in a few working days.`,
      "payment.refunded",
    ),
    toAdmins(order, `Refunded ${order.orderNumber}`, rupees(amountPaise), {
      type: "payment.refunded",
      link: "/admin/payments",
    }),
  ]);
}

/** In-app notifications for an order status change (`previous` is the order before it). */
export async function notifyStatusChange(order, actor, previous) {
  const r = ref(order);
  const reason = order.cancellation?.reason;
  const restaurantName = order.restaurantSnapshot.name;

  switch (order.status) {
    case S.CONFIRMED:
      return toCustomer(
        order,
        `${r} accepted`,
        `${restaurantName} is getting your food ready.`,
      );
    case S.PREPARING:
      return toCustomer(
        order,
        `${r} is being prepared`,
        `${restaurantName} has started cooking your food.`,
      );
    case S.REJECTED:
      return Promise.all([
        toCustomer(
          order,
          `${r} could not be accepted`,
          reason || `${restaurantName} could not take this order.`,
        ),
        toAdmins(
          order,
          `${r} rejected`,
          `${restaurantName}: ${reason || "no reason given"}`,
        ),
      ]);
    case S.READY_FOR_PICKUP:
      // An admin took the order back from its rider (it is offered to someone else next).
      return previous?.deliveryPartner
        ? toRider(
            previous.deliveryPartner,
            order,
            `${r} reassigned`,
            "BiteBox support gave it to another rider.",
          )
        : undefined;
    case S.ASSIGNED:
      return Promise.all([
        toCustomer(
          order,
          "A rider is on the way to the restaurant",
          `${r} has a delivery partner.`,
        ),
        toRestaurant(
          order,
          `Rider assigned to ${r}`,
          "Keep the order ready for pickup.",
        ),
      ]);
    case S.ARRIVED_AT_RESTAURANT:
      return toRestaurant(
        order,
        `Rider has arrived for ${r}`,
        "Hand the order to the rider.",
      );
    case S.PICKED_UP:
      return Promise.all([
        toCustomer(
          order,
          `${r} picked up`,
          order.deliveryOtp
            ? `Your rider has collected your food. Your delivery code is ${order.deliveryOtp}: share it with the rider only when you have your order.`
            : "Your rider has collected your food from the restaurant.",
        ),
        toRestaurant(order, `${r} picked up`, "The rider has collected it."),
      ]);
    case S.ON_THE_WAY:
      return toCustomer(
        order,
        `${r} is out for delivery`,
        "Track your rider live on the order page.",
      );
    case S.DELIVERED:
      return Promise.all([
        toCustomer(order, `${r} delivered`, "Enjoy your meal!"),
        toRestaurant(order, `${r} delivered`, "Earnings are updated."),
        toAdmins(
          order,
          `${r} delivered`,
          `${restaurantName} · ${rupees(order.pricing.totalPaise)}`,
        ),
      ]);
    case S.CANCELLED: {
      // Unpaid checkout attempts never reached the restaurant: not worth an admin's attention.
      const tasks = order.submittedAt
        ? [
            toAdmins(
              order,
              `${r} cancelled`,
              `By ${actor}${reason ? `: ${reason}` : ""}`,
            ),
          ]
        : [];
      if (actor !== "customer")
        tasks.push(
          toCustomer(
            order,
            `${r} cancelled`,
            reason || "This order was cancelled.",
          ),
        );
      if (order.submittedAt && actor !== "restaurant") {
        tasks.push(
          toRestaurant(
            order,
            `${r} cancelled`,
            actor === "customer"
              ? "The customer cancelled before you accepted it."
              : reason,
          ),
        );
      }
      if (previous?.deliveryPartner)
        tasks.push(
          toRider(
            previous.deliveryPartner,
            order,
            `${r} cancelled`,
            "You no longer need to deliver it.",
          ),
        );
      return Promise.all(tasks);
    }
    default:
      return undefined;
  }
}

/** Support reset the delivery code (the rider ran out of tries). */
export const notifyNewDeliveryOtp = (order) =>
  toCustomer(
    order,
    `New delivery code for ${ref(order)}`,
    `Your new code is ${order.deliveryOtp}. Share it with the rider at your door.`,
    "order.delivery_code",
  );
