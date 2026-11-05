import mongoose from "mongoose";

export const REFERRAL_STATUS = Object.freeze({
  PENDING: "PENDING", // reserved: a code was shared but nobody signed up with it yet (not stored today)
  REGISTERED: "REGISTERED", // the friend signed up with the code
  FIRST_ORDER_PLACED: "FIRST_ORDER_PLACED",
  ORDER_DELIVERED: "ORDER_DELIVERED", // qualified; the reward is being paid or waits for a review
  REWARD_CREDITED: "REWARD_CREDITED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
});

export const REFERRAL_REWARD_STATUS = Object.freeze({
  NONE: "NONE",
  HELD: "HELD", // suspicious: an admin approves or rejects it
  CREDITING: "CREDITING",
  CREDITED: "CREDITED",
  PARTIAL: "PARTIAL", // the friend was rewarded; the referrer had reached a limit
  REJECTED: "REJECTED",
});

/** Signals that hold a referral for an admin. Never shown to customers. */
export const REFERRAL_RISK = Object.freeze({
  SAME_SIGNUP_IP: "SAME_SIGNUP_IP",
  ADDRESS_MATCHES_REFERRER: "ADDRESS_MATCHES_REFERRER",
  ADDRESS_SHARED_WITH_OTHER_REFERRAL: "ADDRESS_SHARED_WITH_OTHER_REFERRAL",
  REFERRER_VELOCITY: "REFERRER_VELOCITY",
});

const R = REFERRAL_STATUS;
const ObjectId = mongoose.Schema.Types.ObjectId;

/** One referral: who invited whom, how far the friend got, and what was paid. */
const referralSchema = new mongoose.Schema(
  {
    referrer: { type: ObjectId, ref: "User", required: true },
    referred: { type: ObjectId, ref: "User", required: true },
    code: { type: String, required: true, maxlength: 40 },
    status: { type: String, enum: Object.values(R), default: R.REGISTERED },
    qualifyingOrder: { type: ObjectId, ref: "Order", default: null },
    attributionExpiresAt: { type: Date, required: true },
    referrerCoins: { type: Number, default: 0, min: 0 },
    referredCoins: { type: Number, default: 0, min: 0 },
    rewardStatus: {
      type: String,
      enum: Object.values(REFERRAL_REWARD_STATUS),
      default: REFERRAL_REWARD_STATUS.NONE,
    },
    // The referrer's monthly reward slot ("2026-11") once claimed, so a retry never claims twice.
    referrerSlot: { type: String, default: null },
    rewardedAt: { type: Date, default: null },
    // Staff-only.
    riskFlags: { type: [String], enum: Object.values(REFERRAL_RISK), default: [] },
    signupIp: { type: String, maxlength: 64, select: false },
    decision: {
      by: { type: ObjectId, ref: "User" },
      note: { type: String, maxlength: 300 },
      at: Date,
    },
    history: [
      {
        _id: false,
        status: { type: String, enum: Object.values(R) },
        at: { type: Date, default: Date.now },
        note: { type: String, maxlength: 200 },
      },
    ],
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.signupIp;
        return ret;
      },
    },
  },
);

// One referrer per customer, ever.
referralSchema.index({ referred: 1 }, { unique: true });
referralSchema.index({ referrer: 1, createdAt: -1 });
referralSchema.index({ status: 1, attributionExpiresAt: 1 });
referralSchema.index({ rewardStatus: 1, updatedAt: 1 });

export const Referral = mongoose.model("Referral", referralSchema);

/** Rewards paid to a referrer per calendar month: claimed atomically to enforce the monthly limit. */
const counterSchema = new mongoose.Schema({
  referrer: { type: ObjectId, ref: "User", required: true },
  period: { type: String, required: true }, // "2026-11"
  count: { type: Number, default: 0, min: 0 },
});
counterSchema.index({ referrer: 1, period: 1 }, { unique: true });

export const ReferralRewardCounter = mongoose.model("ReferralRewardCounter", counterSchema);
