import { logger } from "../config/logger.js";
import { Cart } from "../models/cart.model.js";
import { Coupon, CouponRedemption } from "../models/coupon.model.js";
import { FoodItem } from "../models/food-item.model.js";
import {
  ORDER_COIN_STATES,
  ORDER_STATUS,
  Order,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  Payment,
} from "../models/order.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import {
  REVIEW_STATUS,
  REVIEW_TARGETS,
  Review,
} from "../models/review.model.js";
import { randomCode } from "../utils/codes.js";
import { ApiError } from "../utils/api-error.js";
import { paginationMeta } from "../utils/pagination.js";
import { withTransaction } from "../utils/transaction.js";
import * as addressService from "./address.service.js";
import * as cartService from "./cart.service.js";
import * as coinsService from "./coins.service.js";
import * as couponService from "./coupon.service.js";
import * as rewardEvents from "./reward-events.js";
import { notifyNewOrder } from "./order-notifications.js";
import { providerFor } from "./payments/payment.service.js";


const conflict = (message, code, details) =>
  new ApiError(409, message, { code, details });

export async function placeOrder(
  userId,
  { addressId, paymentMethod, note, expectedTotalPaise },
  idempotencyKey,
) {
  if (idempotencyKey) {
    const existing = await Order.findOne({ customer: userId, idempotencyKey });
    if (existing) return { order: existing, created: false };
  }
  const provider = providerFor(paymentMethod); // throws when online payment is unavailable

  const address = await addressService.getOwn(userId, addressId);
  const quote = await cartService.buildQuote(userId, { addressId });
  if (!quote.cart) throw ApiError.badRequest("Your cart is empty");
  if (quote.couponError) {
    throw conflict(
      `Coupon ${quote.couponError.code} can no longer be applied: ${quote.couponError.message}`,
      "COUPON_INVALID",
    );
  }
  if (!quote.canCheckout) {
    throw conflict(
      quote.issues[0]?.message ?? "This order cannot be placed",
      "CHECKOUT_BLOCKED",
      quote.issues.map((i) => ({ field: i.code, message: i.message })),
    );
  }
  if (
    expectedTotalPaise !== undefined &&
    expectedTotalPaise !== quote.pricing.totalPaise
  ) {
    throw conflict(
      "Prices changed since you last looked. Please review your order.",
      "PRICE_CHANGED",
    );
  }

  const coinsRedeemed = quote.coins?.applied ?? 0;
  if (coinsRedeemed && !quote.coins.paymentMethods.includes(paymentMethod)) {
    throw conflict(
      "Coins can't be used with this payment method. Remove the coins or pay another way.",
      "COINS_NOT_ALLOWED",
    );
  }

  const restaurant = await Restaurant.findById(quote.cart.restaurant.id);
  const foods = await FoodItem.find({
    _id: { $in: quote.cart.items.map((l) => l.foodItemId) },
  }).select("_id");
  if (foods.length !== quote.cart.items.length)
    throw conflict("Some dishes are no longer available", "CHECKOUT_BLOCKED");

  const orderNumber = randomCode("BB");
  const now = new Date();
  const orderDoc = {
    orderNumber,
    customer: userId,
    restaurant: restaurant._id,
    restaurantSnapshot: {
      name: restaurant.name,
      slug: restaurant.slug,
      phone: restaurant.phone,
      address: [
        restaurant.address.line1,
        restaurant.address.area,
        restaurant.address.city,
      ]
        .filter(Boolean)
        .join(", "),
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
    coupon: quote.coupon
      ? { code: quote.coupon.code, discountPaise: quote.pricing.discountPaise }
      : undefined,
    coins: coinsRedeemed
      ? {
          redeemed: coinsRedeemed,
          discountPaise: quote.pricing.coinDiscountPaise,
          // Cash orders spend the coins now; online orders hold them until paid.
          state:
            paymentMethod === PAYMENT_METHODS.COD
              ? ORDER_COIN_STATES.COMMITTED
              : ORDER_COIN_STATES.RESERVED,
        }
      : undefined,
    distanceMeters: quote.delivery.distanceMeters,
    note: note || undefined,
    status: ORDER_STATUS.PENDING,
    statusHistory: [{ status: ORDER_STATUS.PENDING, at: now, by: userId }],
    paymentMethod,
    paymentStatus: PAYMENT_STATUS.PENDING,
    // Cash orders go to the restaurant now; online ones once paid (see payments/payment.service.js).
    submittedAt: paymentMethod === PAYMENT_METHODS.COD ? now : null,
    idempotencyKey: idempotencyKey || undefined,
  };

  try {
    const order = await withTransaction((session) =>
      commitOrder(
        { userId, quote, orderDoc, paymentMethod, provider },
        session,
      ),
    );
    logger.info(
      { orderId: order.id, orderNumber, userId: String(userId) },
      "Order placed",
    );
    await rewardEvents.orderPlaced(order);
    if (order.submittedAt) await notifyNewOrder(order, "cash on delivery");
    return { order, created: true };
  } catch (error) {
    // A concurrent retry with the same idempotency key won the race: return its order.
    if (
      error?.code === 11000 &&
      idempotencyKey &&
      error.keyPattern?.idempotencyKey
    ) {
      const existing = await Order.findOne({
        customer: userId,
        idempotencyKey,
      });
      if (existing) return { order: existing, created: false };
    }
    throw error;
  }
}

/** The write phase. `session` is null when transactions are unavailable (compensating fallback). */
async function commitOrder(
  { userId, quote, orderDoc, paymentMethod, provider },
  session,
) {
  const undo = [];
  try {
    // 1. Claim the cart. If it changed after we priced it (another tab, another checkout), stop.
    const claimed = await Cart.findOneAndDelete(
      { _id: quote.cart.id, user: userId, __v: quote.cart.version },
      { session },
    );
    if (!claimed)
      throw conflict(
        "Your cart changed. Please review it and try again.",
        "CART_CHANGED",
      );
    undo.push(() => Cart.create([claimed.toObject()]));

    // 2. Reserve a coupon use atomically (respecting the global usage limit) and re-check per-user use.
    let coupon = null;
    if (quote.coupon) {
      coupon = await couponService.assertEligible(
        quote.coupon.code,
        {
          userId,
          restaurantId: quote.cart.restaurant.id,
          subtotalPaise: quote.pricing.subtotalPaise,
        },
        session,
      );
      const reserved = await Coupon.findOneAndUpdate(
        {
          _id: coupon._id,
          isActive: true,
          $or: [
            { usageLimit: null },
            { $expr: { $lt: ["$usedCount", "$usageLimit"] } },
          ],
        },
        { $inc: { usedCount: 1 } },
        { session, returnDocument: "after" },
      );
      if (!reserved)
        throw conflict(
          "This coupon has just been fully redeemed",
          "COUPON_EXHAUSTED",
        );
      undo.push(() =>
        Coupon.updateOne({ _id: coupon._id }, { $inc: { usedCount: -1 } }),
      );
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
          provider,
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
      await CouponRedemption.create(
        [
          {
            coupon: coupon._id,
            user: userId,
            order: order._id,
            discountPaise: order.pricing.discountPaise,
          },
        ],
        { session },
      );
      // Without this, a later failure would leave the coupon counted as used by this customer.
      undo.push(() => CouponRedemption.deleteOne({ order: order._id }));
    }

    // 4. Hold the redeemed coins (cash orders spend them straight away).
    await coinsService.reserveForOrder(
      userId,
      order,
      { cash: paymentMethod === PAYMENT_METHODS.COD },
      session,
      undo,
    );
    return order;
  } catch (error) {
    if (!session) {
      // No transaction: roll back completed steps in reverse order.
      for (const step of undo.reverse()) {
        await step().catch((undoError) =>
          logger.error({ err: undoError }, "Order rollback step failed"),
        );
      }
    }
    throw error;
  }
}

export async function listMine(userId, pagination) {
  // Checkout attempts abandoned at the payment page never became orders for the customer.
  const filter = {
    customer: userId,
    $nor: [
      {
        paymentMethod: PAYMENT_METHODS.ONLINE,
        submittedAt: null,
        status: ORDER_STATUS.CANCELLED,
      },
    ],
  };
  const [items, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .select(
        "orderNumber restaurant restaurantSnapshot.name restaurantSnapshot.slug items pricing.totalPaise status paymentMethod paymentStatus createdAt",
      ),
    Order.countDocuments(filter),
  ]);
  // The customer's own restaurant rating, shown on each delivered order in the history.
  const rated = await Review.find({
    customer: userId,
    target: REVIEW_TARGETS.RESTAURANT,
    order: { $in: items.map((o) => o._id) },
    status: { $ne: REVIEW_STATUS.DELETED },
  }).select("order rating");
  const ratingByOrder = new Map(rated.map((r) => [String(r.order), r.rating]));
  return {
    items: items.map((o) => ({
      ...o.toJSON(),
      myRating: ratingByOrder.get(String(o._id)) ?? null,
    })),
    pagination: paginationMeta(pagination, total),
  };
}
