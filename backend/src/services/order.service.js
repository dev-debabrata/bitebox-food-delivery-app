import crypto from "node:crypto";
import { logger } from "../config/logger.js";
import { Cart } from "../models/cart.model.js";
import { Coupon, CouponRedemption } from "../models/coupon.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { ORDER_STATUS, Order, PAYMENT_METHODS, PAYMENT_STATUS, Payment } from "../models/order.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { emitOrderUpdated } from "../sockets/events.js";
import { ApiError } from "../utils/api-error.js";
import { paginationMeta } from "../utils/pagination.js";
import { withTransaction } from "../utils/transaction.js";
import * as addressService from "./address.service.js";
import * as cartService from "./cart.service.js";
import * as couponService from "./coupon.service.js";

/** e.g. BB-261102-7KQ4XZ (date + 6 random base32 characters). */
function newOrderNumber() {
  const date = new Date().toISOString().slice(2, 10).replaceAll("-", "");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random = Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join("");
  return `BB-${date}-${random}`;
}

const conflict = (message, code, details) => new ApiError(409, message, { code, details });

/**
 * Turns the customer's cart into an order.
 *
 * Safety guarantees:
 * - Prices, fees and discounts are recomputed on the server (buildQuote).
 * - `expectedTotalPaise` (what the customer saw) must match, otherwise 409 PRICE_CHANGED.
 * - The cart is claimed with a version-checked delete, so the same cart can never become two orders.
 * - `idempotencyKey` makes retries (double clicks, flaky networks) return the original order.
 * - Coupon usage limits are enforced with an atomic conditional increment.
 * - Everything runs in a MongoDB transaction when available; otherwise each
 *   completed step is undone if a later one fails.
 */
export async function placeOrder(userId, { addressId, paymentMethod, note, expectedTotalPaise }, idempotencyKey) {
  if (idempotencyKey) {
    const existing = await Order.findOne({ customer: userId, idempotencyKey });
    if (existing) return { order: existing, created: false };
  }
  if (paymentMethod !== PAYMENT_METHODS.COD) throw ApiError.badRequest("Only Cash on Delivery is available right now");

  const address = await addressService.getOwn(userId, addressId);
  const quote = await cartService.buildQuote(userId, { addressId });
  if (!quote.cart) throw ApiError.badRequest("Your cart is empty");
  if (quote.couponError) {
    throw conflict(`Coupon ${quote.couponError.code} can no longer be applied: ${quote.couponError.message}`, "COUPON_INVALID");
  }
  if (!quote.canCheckout) {
    throw conflict(quote.issues[0]?.message ?? "This order cannot be placed", "CHECKOUT_BLOCKED", quote.issues.map((i) => ({ field: i.code, message: i.message })));
  }
  if (expectedTotalPaise !== undefined && expectedTotalPaise !== quote.pricing.totalPaise) {
    throw conflict("Prices changed since you last looked. Please review your order.", "PRICE_CHANGED");
  }

  const restaurant = await Restaurant.findById(quote.cart.restaurant.id);
  const foods = await FoodItem.find({ _id: { $in: quote.cart.items.map((l) => l.foodItemId) } }).select("_id");
  if (foods.length !== quote.cart.items.length) throw conflict("Some dishes are no longer available", "CHECKOUT_BLOCKED");

  const orderNumber = newOrderNumber();
  const now = new Date();
  const orderDoc = {
    orderNumber,
    customer: userId,
    restaurant: restaurant._id,
    restaurantSnapshot: {
      name: restaurant.name,
      slug: restaurant.slug,
      phone: restaurant.phone,
      address: [restaurant.address.line1, restaurant.address.area, restaurant.address.city].filter(Boolean).join(", "),
      location: restaurant.location,
    },
    items: quote.cart.items.map((l) => ({
      foodItem: l.foodItemId,
      name: l.name,
      isVeg: l.isVeg,
      unitPricePaise: l.unitPricePaise,
      quantity: l.quantity,
      lineTotalPaise: l.lineTotalPaise,
    })),
    deliveryAddress: {
      label: address.label,
      recipientName: address.recipientName,
      phone: address.phone,
      line1: address.line1,
      line2: address.line2,
      area: address.area,
      landmark: address.landmark,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      location: address.location,
    },
    pricing: quote.pricing,
    coupon: quote.coupon ? { code: quote.coupon.code, discountPaise: quote.pricing.discountPaise } : undefined,
    distanceMeters: quote.delivery.distanceMeters,
    note: note || undefined,
    status: ORDER_STATUS.PENDING,
    statusHistory: [{ status: ORDER_STATUS.PENDING, at: now, by: userId }],
    paymentMethod,
    paymentStatus: PAYMENT_STATUS.PENDING,
    idempotencyKey: idempotencyKey || undefined,
  };

  try {
    const order = await withTransaction((session) => commitOrder({ userId, quote, orderDoc, paymentMethod }, session));
    logger.info({ orderId: order.id, orderNumber, userId: String(userId) }, "Order placed");
    emitOrderUpdated(order); // the restaurant's board lights up
    return { order, created: true };
  } catch (error) {
    // A concurrent retry with the same idempotency key won the race: return its order.
    if (error?.code === 11000 && idempotencyKey && error.keyPattern?.idempotencyKey) {
      const existing = await Order.findOne({ customer: userId, idempotencyKey });
      if (existing) return { order: existing, created: false };
    }
    throw error;
  }
}

/** The write phase. `session` is null when transactions are unavailable (compensating fallback). */
async function commitOrder({ userId, quote, orderDoc, paymentMethod }, session) {
  const undo = [];
  try {
    // 1. Claim the cart. If it changed after we priced it (another tab, another checkout), stop.
    const claimed = await Cart.findOneAndDelete({ _id: quote.cart.id, user: userId, __v: quote.cart.version }, { session });
    if (!claimed) throw conflict("Your cart changed. Please review it and try again.", "CART_CHANGED");
    undo.push(() => Cart.create([claimed.toObject()]));

    // 2. Reserve a coupon use atomically (respecting the global usage limit) and re-check per-user use.
    let coupon = null;
    if (quote.coupon) {
      coupon = await couponService.assertEligible(
        quote.coupon.code,
        { userId, restaurantId: quote.cart.restaurant.id, subtotalPaise: quote.pricing.subtotalPaise },
        session,
      );
      const reserved = await Coupon.findOneAndUpdate(
        { _id: coupon._id, isActive: true, $or: [{ usageLimit: null }, { $expr: { $lt: ["$usedCount", "$usageLimit"] } }] },
        { $inc: { usedCount: 1 } },
        { session, returnDocument: "after" },
      );
      if (!reserved) throw conflict("This coupon has just been fully redeemed", "COUPON_EXHAUSTED");
      undo.push(() => Coupon.updateOne({ _id: coupon._id }, { $inc: { usedCount: -1 } }));
    }

    // 3. Create the order and its payment record.
    const [order] = await Order.create([orderDoc], { session });
    undo.push(() => Order.deleteOne({ _id: order._id }));

    const [payment] = await Payment.create(
      [
        {
          order: order._id,
          user: userId,
          method: paymentMethod,
          provider: "cash_on_delivery",
          amountPaise: order.pricing.totalPaise,
          status: PAYMENT_STATUS.PENDING,
        },
      ],
      { session },
    );
    undo.push(() => Payment.deleteOne({ _id: payment._id }));

    order.payment = payment._id;
    await order.save({ session });

    if (coupon) {
      await CouponRedemption.create([{ coupon: coupon._id, user: userId, order: order._id, discountPaise: order.pricing.discountPaise }], { session });
    }
    return order;
  } catch (error) {
    if (!session) {
      // No transaction: roll back completed steps in reverse order.
      for (const step of undo.reverse()) {
        await step().catch((undoError) => logger.error({ err: undoError }, "Order rollback step failed"));
      }
    }
    throw error;
  }
}

export async function listMine(userId, pagination) {
  const filter = { customer: userId };
  const [items, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .select("orderNumber restaurant restaurantSnapshot.name restaurantSnapshot.slug items pricing.totalPaise status paymentMethod paymentStatus createdAt"),
    Order.countDocuments(filter),
  ]);
  return { items, pagination: paginationMeta(pagination, total) };
}
