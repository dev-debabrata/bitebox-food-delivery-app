import { logger } from "../config/logger.js";
import { REVIEW_TARGETS } from "../models/review.model.js";
import * as coins from "./coins.service.js";
import { WELCOME_TRIGGERS } from "../config/rewards.js";
import * as referrals from "./referral.service.js";
import * as special from "./special-rewards.service.js";

/**
 * The single place where order, review and account events reach the rewards programme.
 * Every step is idempotent (ledger keys, conditional updates) and best-effort: a rewards failure
 * is logged and never fails the order, payment, review or sign-up that triggered it. The rewards
 * sweep retries what can be retried (pending ledger rows, unsettled coin holds, half-paid referrals).
 */

async function safely(step, context, work) {
  try {
    return await work();
  } catch (err) {
    logger.error({ err, step, ...context }, "Rewards step failed");
    return undefined;
  }
}

const ctx = (order) => ({ orderId: String(order._id) });

/** A customer account was created (`referral` is what referral.resolveCode accepted, if any). */
export async function customerRegistered(user, { referral, ip } = {}) {
  const context = { userId: String(user._id) };
  await safely("referral.code", context, () => referrals.ensureReferralCode(user._id));
  if (referral)
    await safely("referral.signup", context, () => referrals.recordSignup(user, referral, { ip }));
  await safely("welcome.registration", context, () =>
    special.maybeWelcome(user._id, WELCOME_TRIGGERS.REGISTRATION),
  );
}

/** A customer placed an order (paid or not yet). */
export async function orderPlaced(order) {
  await safely("referral.orderPlaced", ctx(order), () => referrals.onOrderPlaced(order));
}

/** An online order was paid (or a paid order reached the restaurant). */
export async function orderPaid(order) {
  await safely("coins.commit", ctx(order), () => coins.commitForOrder(order));
}

/** The order was rejected or cancelled. */
export async function orderClosed(order) {
  await safely("coins.return", ctx(order), () => coins.returnForOrder(order));
  await safely("referral.orderClosed", ctx(order), () => referrals.onOrderClosed(order));
}

/** The order was delivered. */
export async function orderDelivered(order) {
  await safely("coins.orderReward", ctx(order), () => coins.rewardDeliveredOrder(order));
  await safely("referral.qualify", ctx(order), () => referrals.onOrderDelivered(order));
  await safely("welcome.firstOrder", ctx(order), () =>
    special.maybeWelcome(order.customer, WELCOME_TRIGGERS.FIRST_ORDER),
  );
  await safely("campaigns.order", ctx(order), () => special.onOrderDelivered(order));
}

/** Reviews were posted for an order (the restaurant review earns the bonus). */
export async function reviewsPosted(order, reviews) {
  const restaurantReview = reviews.find((r) => r.target === REVIEW_TARGETS.RESTAURANT);
  if (!restaurantReview) return;
  await safely("coins.reviewReward", ctx(order), () => coins.rewardReview(order, restaurantReview));
}

/** A restaurant review stopped counting (removed by moderation, deleted by its author). */
export async function reviewWithdrawn(review, why) {
  if (review.target !== REVIEW_TARGETS.RESTAURANT) return;
  await safely("coins.reviewReversal", { reviewId: String(review._id) }, () =>
    coins.reverseReviewReward(review.customer, review.order, why),
  );
}
