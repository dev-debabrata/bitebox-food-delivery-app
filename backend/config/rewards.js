import { env } from "./env.js";

/**
 * Coins, referral and special-rewards constants and the default reward configuration.
 * The live configuration is the RewardConfiguration document (super admin editable);
 * these defaults fill any value it does not set. See docs/COINS_REWARDS_PLAN.md.
 *
 * Coins are integers. Money is integer paise. Coins are a platform loyalty reward and are kept
 * apart from payment balances, restaurant payouts and rider earnings.
 */

/** Ledger row types. How each one changes the wallet: services/coin-wallet.service.js#applyTxn. */
export const COIN_TXN_TYPES = Object.freeze({
  CREDIT: "CREDIT", // coins earned: available += c
  DEBIT: "DEBIT", // a reservation is spent (order paid): reserved -= c
  RESERVE: "RESERVE", // coins held for an order: available -= c, reserved += c
  RELEASE: "RELEASE", // a hold is given back: reserved -= c, available += c
  EXPIRE: "EXPIRE", // a batch reached its expiry date: available -= c
  REVERSAL: "REVERSAL", // an earned reward is clawed back, or a spent redemption is refunded
});

/** What a REVERSAL undoes. */
export const REVERSAL_OF = Object.freeze({
  CREDIT: "credit", // claw back coins that were earned (refund, fraud): available goes down
  REDEMPTION: "redemption", // give back coins that were spent (order cancelled): available goes up
});

/** Why the coins moved. */
export const COIN_SOURCES = Object.freeze({
  ORDER_REWARD: "ORDER_REWARD",
  REVIEW_REWARD: "REVIEW_REWARD",
  REFERRAL_REWARD: "REFERRAL_REWARD",
  WELCOME_REWARD: "WELCOME_REWARD",
  BIRTHDAY_REWARD: "BIRTHDAY_REWARD",
  FESTIVAL_REWARD: "FESTIVAL_REWARD",
  PROMOTIONAL_REWARD: "PROMOTIONAL_REWARD",
  COIN_REDEMPTION: "COIN_REDEMPTION",
  COIN_EXPIRY: "COIN_EXPIRY",
  REWARD_REVERSAL: "REWARD_REVERSAL",
});

const C = COIN_SOURCES;

/** Sources that create coins (a credit batch). Each has its own expiry period. */
export const EARN_SOURCES = Object.freeze([
  C.ORDER_REWARD,
  C.REVIEW_REWARD,
  C.REFERRAL_REWARD,
  C.WELCOME_REWARD,
  C.BIRTHDAY_REWARD,
  C.FESTIVAL_REWARD,
  C.PROMOTIONAL_REWARD,
]);

export const WELCOME_TRIGGERS = Object.freeze({
  REGISTRATION: "registration",
  FIRST_ORDER: "first_order",
});

/** Hard limits that the configuration cannot exceed (guards against typos such as an extra zero). */
export const COIN_LIMITS = Object.freeze({
  maxCoinsPerOperation: 10_000_000,
  maxRewardCoins: 1_000_000,
  maxExpiryDays: 3650,
});

/** The rewards background sweep (services/rewards-jobs.service.js). */
export const REWARDS_JOBS = Object.freeze({
  sweepIntervalMs: 2 * 60_000,
  // Upper bound of records each step handles per run, so one run never runs long.
  batchSize: 200,
});

/** Ledger engine tuning. */
export const LEDGER = Object.freeze({
  // Optimistic retries when several operations race for the same wallet.
  maxAttempts: 30,
  // Pending ledger rows older than this are finished by the rewards sweep.
  pendingRecoveryMs: 60_000,
});

/**
 * Default reward configuration. Examples follow the product brief: 10 coins per ₹100,
 * 5 coins per review, 100 coins = ₹10, 180-day expiry, 50 + 25 referral coins.
 */
export const DEFAULT_REWARD_CONFIG = Object.freeze({
  // Master switch: when off, nobody earns or redeems coins (balances and history stay).
  coinsEnabled: true,
  earning: {
    order: {
      enabled: true,
      // coins = floor(eligible food value / unitPaise) * coinsPerUnit
      coinsPerUnit: 10,
      unitPaise: 10_000, // ₹100
      // The eligible value is the food subtotal after coupon and coin discounts
      // (delivery fee, platform fee and tax are never included).
      minOrderPaise: 0,
      maxCoinsPerOrder: 500,
    },
    review: {
      enabled: true,
      coins: 5,
      // 0 accepts a rating without a written comment.
      minCommentLength: 0,
    },
  },
  redemption: {
    enabled: true,
    // Conversion: coinValueCoins coins are worth coinValuePaise paise (100 coins = ₹10).
    coinValueCoins: 100,
    coinValuePaise: 1000,
    minCoins: 100,
    maxCoinsPerOrder: 2000,
    // At most this share of the food value (subtotal after coupon) can be paid with coins.
    maxPercentOfOrder: 20,
    minOrderPaise: 19_900, // ₹199
    paymentMethods: ["cod", "online"],
  },
  expiry: {
    enabled: true,
    // Days until coins from each source expire. 0 = never.
    days: Object.fromEntries(EARN_SOURCES.map((s) => [s, 180])),
    // Coins returned by a cancelled order stay valid for at least this many days.
    restoreGraceDays: 7,
    // "Expiring soon" on the wallet page.
    expiringSoonDays: 30,
  },
  referral: {
    enabled: true,
    referrerCoins: 50,
    referredCoins: 25,
    // The referred customer's first delivered order must be worth at least this (food value).
    minOrderPaise: 19_900,
    // The referred customer has this many days after signing up to complete that order.
    attributionDays: 30,
    maxReferralsPerCustomer: 50,
    maxRewardsPerMonth: 10,
  },
  birthday: { enabled: true, coins: 100 },
  welcome: {
    enabled: true,
    coins: 25,
    trigger: WELCOME_TRIGGERS.REGISTRATION,
  },
  // Calendar used for birthdays and day-based limits.
  timezone: env.reportTimezone,
});
