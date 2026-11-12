import { logger } from "../config/logger.js";
import { COIN_SOURCES } from "../config/rewards.js";
import {
  FINAL_STATUSES,
  ORDER_COIN_STATES,
  ORDER_STATUS,
  Order,
  PAYMENT_STATUS,
} from "../models/order.model.js";
import { ApiError } from "../utils/api-error.js";
import * as wallet from "./coin-wallet.service.js";
import { notify } from "./notification.service.js";
import { rupees } from "./order-notifications.js";
import { coinsToPaise, getRewardConfig } from "./reward-config.service.js";

/**
 * Coins at checkout and the coins customers earn from orders and reviews. Ledger mechanics live in
 * coin-wallet.service.js; this module decides *when* and *how many*.
 *
 * Order coin lifecycle (order.coins.state):
 *   placed -> reserved (online, until paid) | committed (cash on delivery)
 *   paid online            -> committed
 *   rejected / cancelled   -> released (was reserved) | refunded (was committed)
 */

const CS = ORDER_COIN_STATES;
const reserveKey = (orderId) => `coins:reserve:${orderId}`;
const orderRewardKey = (orderId) => `order-reward:${orderId}`;
const reviewRewardKey = (orderId) => `review-reward:${orderId}`;

/** The food value rewards and redemption caps are measured on: subtotal after the coupon. */
export const foodValuePaise = (pricing) =>
  pricing.subtotalPaise - (pricing.discountPaise ?? 0);

/** A rule applies only while the whole coins programme is on. */
export const ruleOn = (config, rule) => config.coinsEnabled && rule.enabled;
const redemptionOn = (config) => ruleOn(config, config.redemption);

/** Redemption rules the customer may see (checkout, wallet page). */
export function customerRules(config) {
  const r = config.redemption;
  return {
    enabled: redemptionOn(config),
    earningEnabled: ruleOn(config, config.earning.order),
    coinValueCoins: r.coinValueCoins,
    coinValuePaise: r.coinValuePaise,
    minCoins: r.minCoins,
    maxCoinsPerOrder: r.maxCoinsPerOrder,
    maxPercentOfOrder: r.maxPercentOfOrder,
    minOrderPaise: r.minOrderPaise,
    paymentMethods: [...r.paymentMethods],
    order: {
      coinsPerUnit: config.earning.order.coinsPerUnit,
      unitPaise: config.earning.order.unitPaise,
      minOrderPaise: config.earning.order.minOrderPaise,
      maxCoinsPerOrder: config.earning.order.maxCoinsPerOrder,
    },
    reviewCoins: ruleOn(config, config.earning.review) ? config.earning.review.coins : 0,
    expiry: {
      enabled: config.expiry.enabled,
      days: { ...config.expiry.days },
    },
  };
}

/**
 * How many coins can pay for this cart. Pure: `available` is the customer's spendable balance.
 * The applied amount is the request clamped to the caps; below the minimum nothing applies.
 */
export function redemptionQuote({ config, available, requested = 0, foodPaise }) {
  const r = config.redemption;
  const base = {
    enabled: redemptionOn(config),
    available,
    requested,
    applied: 0,
    discountPaise: 0,
    maxRedeemable: 0,
    minCoins: r.minCoins,
    coinValueCoins: r.coinValueCoins,
    coinValuePaise: r.coinValuePaise,
    paymentMethods: [...r.paymentMethods],
    message: null,
  };
  if (!base.enabled) return { ...base, message: requested ? "Coins can't be used right now" : null };
  if (foodPaise < r.minOrderPaise)
    return {
      ...base,
      message: `Coins can be used on orders of ${rupees(r.minOrderPaise)} or more`,
    };
  const capPaise = Math.floor((foodPaise * r.maxPercentOfOrder) / 100);
  const byPercent = Math.floor((capPaise * r.coinValueCoins) / r.coinValuePaise);
  const maxRedeemable = Math.max(0, Math.min(available, r.maxCoinsPerOrder, byPercent));
  const quote = { ...base, maxRedeemable };
  if (maxRedeemable < r.minCoins) {
    return {
      ...quote,
      maxRedeemable: 0,
      message:
        available < r.minCoins
          ? `You need at least ${r.minCoins} coins to redeem`
          : `Add more to your order to use at least ${r.minCoins} coins`,
    };
  }
  if (!requested) return quote;
  if (requested < r.minCoins)
    return { ...quote, message: `Redeem at least ${r.minCoins} coins` };
  const applied = Math.min(requested, maxRedeemable);
  return {
    ...quote,
    applied,
    discountPaise: coinsToPaise(applied, config),
    message:
      applied < requested ? `Up to ${maxRedeemable} coins can be used on this order` : null,
  };
}

/** The configuration and spendable balance for the checkout coins block (see `redemptionQuote`). */
export async function loadCartCoins(userId) {
  const config = await getRewardConfig();
  // No wallet read while redemption is off: the quote says so and applies nothing.
  const available = redemptionOn(config) ? await wallet.spendableCoins(userId, config) : 0;
  return { config, available };
}

/** Validates the amount a customer asks for (cart PUT): it must be usable on the current cart. */
export function assertRedeemable(quote, coins) {
  if (!quote.enabled)
    throw new ApiError(422, "Coins can't be used right now", { code: "COINS_UNAVAILABLE" });
  if (quote.maxRedeemable === 0)
    throw new ApiError(422, quote.message ?? "Coins can't be used on this order", {
      code: "COINS_NOT_REDEEMABLE",
    });
  if (coins < quote.minCoins)
    throw new ApiError(422, `Redeem at least ${quote.minCoins} coins`, { code: "COINS_BELOW_MINIMUM" });
}

// ---------------------------------------------------------------------------
// Order hooks
// ---------------------------------------------------------------------------

/**
 * Inside order placement (commitOrder): holds the coins. Cash orders spend them at once.
 * Each completed step adds its undo to `undo` (the no-transaction fallback).
 */
export async function reserveForOrder(userId, order, { cash }, session, undo) {
  const coins = order.coins?.redeemed ?? 0;
  if (!coins) return;
  const key = reserveKey(order._id);
  await wallet.reserve(userId, { coins, key, order: order._id, description: `${coins} coins used on order ${order.orderNumber}` }, { session });
  undo.push(() => wallet.releaseReservation(userId, { reserveKey: key }));
  if (cash) {
    await wallet.commitReservation(userId, { reserveKey: key, description: `${coins} coins redeemed on order ${order.orderNumber}` }, { session });
    undo.pop();
    undo.push(() => wallet.refundRedemption(userId, { reserveKey: key }));
  }
}

/** An online order was paid: spend its reserved coins. Safe to repeat. */
export async function commitForOrder(order) {
  if (order.coins?.state !== CS.RESERVED) return;
  await wallet.commitReservation(order.customer, {
    reserveKey: reserveKey(order._id),
    description: `${order.coins.redeemed} coins redeemed on order ${order.orderNumber}`,
  });
  await Order.updateOne(
    { _id: order._id, "coins.state": CS.RESERVED },
    { $set: { "coins.state": CS.COMMITTED } },
  );
}

/** The order was rejected or cancelled: give the coins back (released or refunded). Safe to repeat. */
export async function returnForOrder(order) {
  const state = order.coins?.state;
  if (state !== CS.RESERVED && state !== CS.COMMITTED) return;
  const key = reserveKey(order._id);
  const coins = order.coins.redeemed;
  const refund = async () => {
    await wallet.refundRedemption(order.customer, {
      reserveKey: key,
      description: `${coins} coins refunded: order ${order.orderNumber} ${order.status}`,
    });
    await Order.updateOne(
      { _id: order._id, "coins.state": { $in: [CS.RESERVED, CS.COMMITTED] } },
      { $set: { "coins.state": CS.REFUNDED } },
    );
  };
  if (state === CS.COMMITTED) {
    await refund();
  } else {
    try {
      await wallet.releaseReservation(order.customer, {
        reserveKey: key,
        description: `${coins} coins returned: order ${order.orderNumber} ${order.status}`,
      });
      await Order.updateOne(
        { _id: order._id, "coins.state": CS.RESERVED },
        { $set: { "coins.state": CS.RELEASED } },
      );
    } catch (error) {
      // Paid (so spent) at the same moment: refund the spent coins instead.
      if (error.code !== "RESERVATION_CLOSED") throw error;
      await refund();
    }
  }
  await notify(order.customer, {
    type: "coins.returned",
    title: `${coins} coins are back in your wallet`,
    body: `Order ${order.orderNumber} was ${order.status}`,
    link: "/account/coins",
    order: order._id,
  });
}

/** Coins this order earns: floor(food value after discounts / unit) x coins per unit, capped. */
export function orderRewardCoins(order, config) {
  const rule = config.earning.order;
  if (!ruleOn(config, rule)) return 0;
  const base = foodValuePaise(order.pricing) - (order.pricing.coinDiscountPaise ?? 0);
  if (base <= 0 || base < rule.minOrderPaise) return 0;
  const coins = Math.floor(base / rule.unitPaise) * rule.coinsPerUnit;
  return Math.min(coins, rule.maxCoinsPerOrder);
}

/** Delivered: credit the order reward once. */
export async function rewardDeliveredOrder(order) {
  if (order.status !== ORDER_STATUS.DELIVERED) return null;
  const config = await getRewardConfig();
  const coins = orderRewardCoins(order, config);
  if (!coins) return null;
  const { txn, created } = await wallet.credit(order.customer, {
    coins,
    source: COIN_SOURCES.ORDER_REWARD,
    key: orderRewardKey(order._id),
    order: order._id,
    description: `Reward for order ${order.orderNumber}`,
  });
  await Order.updateOne({ _id: order._id }, { $set: { "coins.earned": txn.coins } });
  if (created)
    await notify(order.customer, {
      type: "coins.earned",
      title: `You earned ${coins} coins`,
      body: `Reward for order ${order.orderNumber}`,
      link: "/account/coins",
      order: order._id,
    });
  return txn;
}

/**
 * A restaurant review was posted for a delivered order: the review bonus, once per order.
 * `review` is the restaurant review document.
 */
export async function rewardReview(order, review) {
  const config = await getRewardConfig();
  const rule = config.earning.review;
  if (!ruleOn(config, rule) || !rule.coins) return null;
  if (order.status !== ORDER_STATUS.DELIVERED) return null;
  if ((review.comment ?? "").trim().length < rule.minCommentLength) return null;
  const { txn, created } = await wallet.credit(order.customer, {
    coins: rule.coins,
    source: COIN_SOURCES.REVIEW_REWARD,
    key: reviewRewardKey(order._id),
    order: order._id,
    description: `Thanks for reviewing order ${order.orderNumber}`,
  });
  if (created)
    await notify(order.customer, {
      type: "coins.earned",
      title: `You earned ${rule.coins} coins`,
      body: "Thanks for your review",
      link: "/account/coins",
      order: order._id,
    });
  return txn;
}

/** The rewarded review was removed by moderation or deleted by its author: take the bonus back. */
export async function reverseReviewReward(customerId, orderId, why) {
  try {
    return await wallet.reverseCredit(customerId, {
      creditKey: reviewRewardKey(orderId),
      key: `${reviewRewardKey(orderId)}:reversal`,
      description: `Review bonus reversed: ${why}`,
    });
  } catch (error) {
    if (["NOT_FOUND", "ALREADY_REVERSED"].includes(error.code)) return null;
    throw error;
  }
}

/**
 * Rewards sweep safety net: orders whose coin hold was not closed by the workflow
 * (e.g. the process stopped between the status change and the follow-up).
 */
export async function settleStaleReservations({ limit = 100 } = {}) {
  const summary = { committed: 0, returned: 0 };
  const stale = await Order.find({
    "coins.state": CS.RESERVED,
    $or: [{ status: { $in: FINAL_STATUSES } }, { paymentStatus: PAYMENT_STATUS.PAID }],
  }).limit(limit);
  for (const order of stale) {
    try {
      if ([ORDER_STATUS.REJECTED, ORDER_STATUS.CANCELLED].includes(order.status)) {
        await returnForOrder(order);
        summary.returned++;
      } else {
        await commitForOrder(order);
        summary.committed++;
      }
    } catch (err) {
      logger.error({ err, orderId: order.id }, "Could not settle an order's coins");
    }
  }
  return summary;
}
