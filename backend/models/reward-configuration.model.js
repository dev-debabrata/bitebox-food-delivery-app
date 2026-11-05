import mongoose from "mongoose";
import {
  COIN_LIMITS,
  DEFAULT_REWARD_CONFIG as D,
  EARN_SOURCES,
  WELCOME_TRIGGERS,
} from "../config/rewards.js";
import { PAYMENT_METHODS } from "./order.model.js";

const whole = (min, max, defaultValue) => ({
  type: Number,
  min,
  max,
  default: defaultValue,
  validate: {
    validator: Number.isInteger,
    message: "{PATH} must be a whole number",
  },
});
const flag = (defaultValue) => ({ type: Boolean, default: defaultValue });
const R = COIN_LIMITS.maxRewardCoins;
const MAX_PAISE = 100_000_000; // ₹10 lakh

const isTimeZone = (value) => {
  try {
    new Intl.DateTimeFormat("en-IN", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/**
 * The global reward settings: a single document (`key: "global"`). Every field has a default
 * from config/rewards.js, so a missing document or a field added later reads as the default.
 * Edited only by the super admin (rewards:manage). `revision` is the version editors send back;
 * optimistic concurrency (`__v`) rejects a save that raced another one.
 */
const rewardConfigurationSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, default: "global", immutable: true },
    coinsEnabled: flag(D.coinsEnabled),
    earning: {
      order: {
        enabled: flag(D.earning.order.enabled),
        coinsPerUnit: whole(0, R, D.earning.order.coinsPerUnit),
        unitPaise: whole(100, MAX_PAISE, D.earning.order.unitPaise),
        minOrderPaise: whole(0, MAX_PAISE, D.earning.order.minOrderPaise),
        maxCoinsPerOrder: whole(0, R, D.earning.order.maxCoinsPerOrder),
      },
      review: {
        enabled: flag(D.earning.review.enabled),
        coins: whole(0, R, D.earning.review.coins),
        minCommentLength: whole(0, 1000, D.earning.review.minCommentLength),
      },
    },
    redemption: {
      enabled: flag(D.redemption.enabled),
      coinValueCoins: whole(1, R, D.redemption.coinValueCoins),
      coinValuePaise: whole(1, MAX_PAISE, D.redemption.coinValuePaise),
      minCoins: whole(1, COIN_LIMITS.maxCoinsPerOperation, D.redemption.minCoins),
      maxCoinsPerOrder: whole(
        1,
        COIN_LIMITS.maxCoinsPerOperation,
        D.redemption.maxCoinsPerOrder,
      ),
      maxPercentOfOrder: whole(1, 100, D.redemption.maxPercentOfOrder),
      minOrderPaise: whole(0, MAX_PAISE, D.redemption.minOrderPaise),
      paymentMethods: {
        type: [{ type: String, enum: Object.values(PAYMENT_METHODS) }],
        default: () => [...D.redemption.paymentMethods],
      },
    },
    expiry: {
      enabled: flag(D.expiry.enabled),
      days: Object.fromEntries(
        EARN_SOURCES.map((s) => [
          s,
          whole(0, COIN_LIMITS.maxExpiryDays, D.expiry.days[s]),
        ]),
      ),
      restoreGraceDays: whole(0, 365, D.expiry.restoreGraceDays),
      expiringSoonDays: whole(1, 365, D.expiry.expiringSoonDays),
    },
    referral: {
      enabled: flag(D.referral.enabled),
      referrerCoins: whole(0, R, D.referral.referrerCoins),
      referredCoins: whole(0, R, D.referral.referredCoins),
      minOrderPaise: whole(0, MAX_PAISE, D.referral.minOrderPaise),
      attributionDays: whole(1, 365, D.referral.attributionDays),
      maxReferralsPerCustomer: whole(1, 100_000, D.referral.maxReferralsPerCustomer),
      maxRewardsPerMonth: whole(1, 10_000, D.referral.maxRewardsPerMonth),
    },
    birthday: {
      enabled: flag(D.birthday.enabled),
      coins: whole(0, R, D.birthday.coins),
    },
    welcome: {
      enabled: flag(D.welcome.enabled),
      coins: whole(0, R, D.welcome.coins),
      trigger: {
        type: String,
        enum: Object.values(WELCOME_TRIGGERS),
        default: D.welcome.trigger,
      },
    },
    timezone: {
      type: String,
      trim: true,
      default: D.timezone,
      validate: { validator: isTimeZone, message: "Unknown time zone" },
    },
    // Bumped on every save (1 = first saved version; 0 means "defaults, never saved").
    revision: { type: Number, default: 0, min: 0 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, optimisticConcurrency: true, minimize: false },
);

rewardConfigurationSchema.pre("validate", function checkRanges() {
  const r = this.redemption;
  if (r.minCoins > r.maxCoinsPerOrder)
    this.invalidate(
      "redemption.minCoins",
      "Minimum redemption cannot be more than the maximum per order",
    );
});

rewardConfigurationSchema.index({ key: 1 }, { unique: true });

export const RewardConfiguration = mongoose.model(
  "RewardConfiguration",
  rewardConfigurationSchema,
);
