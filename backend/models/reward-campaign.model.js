import mongoose from "mongoose";
import { COIN_LIMITS } from "../config/rewards.js";

export const CAMPAIGN_TYPES = Object.freeze({
  FESTIVAL: "FESTIVAL",
  PROMOTIONAL: "PROMOTIONAL",
});

/** How customers get the reward: they tap "Claim", or it comes with a qualifying delivered order. */
export const CAMPAIGN_TRIGGERS = Object.freeze({ CLAIM: "CLAIM", ORDER: "ORDER" });

export const CAMPAIGN_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  SCHEDULED: "SCHEDULED", // activated, starts later
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  EXPIRED: "EXPIRED", // the end date passed
  COMPLETED: "COMPLETED", // limits reached, or ended early by an admin
});

export const CUSTOMER_GROUPS = Object.freeze({
  ALL: "ALL",
  NEW: "NEW", // no delivered order yet
  EXISTING: "EXISTING", // at least one delivered order
  INACTIVE: "INACTIVE", // ordered before, but not in the last `inactiveDays`
});

export const REWARD_TYPES = Object.freeze({
  WELCOME: "WELCOME",
  BIRTHDAY: "BIRTHDAY",
  FESTIVAL: "FESTIVAL",
  PROMOTIONAL: "PROMOTIONAL",
});

const ObjectId = mongoose.Schema.Types.ObjectId;
const whole = (min, max, extra = {}) => ({
  type: Number,
  min,
  max,
  validate: { validator: (v) => v === null || Number.isInteger(v), message: "{PATH} must be a whole number" },
  ...extra,
});

const campaignSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 3, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    type: { type: String, enum: Object.values(CAMPAIGN_TYPES), required: true },
    trigger: { type: String, enum: Object.values(CAMPAIGN_TRIGGERS), default: CAMPAIGN_TRIGGERS.CLAIM },
    rewardCoins: whole(1, COIN_LIMITS.maxRewardCoins, { required: true }),
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    // When this campaign's coins expire. null = the expiry period in the reward settings.
    coinsExpireAt: { type: Date, default: null },
    timezone: { type: String, default: "Asia/Kolkata", maxlength: 60 },
    status: { type: String, enum: Object.values(CAMPAIGN_STATUS), default: CAMPAIGN_STATUS.DRAFT },
    conditions: {
      customerGroup: { type: String, enum: Object.values(CUSTOMER_GROUPS), default: CUSTOMER_GROUPS.ALL },
      inactiveDays: whole(1, 3650, { default: 30 }),
      // Order campaigns only:
      minOrderPaise: whole(0, 100_000_000, { default: 0 }),
      firstOrderOnly: { type: Boolean, default: false },
      restaurants: { type: [{ type: ObjectId, ref: "Restaurant" }], default: [] },
    },
    limits: {
      maxClaimsPerCustomer: whole(1, 1000, { default: 1 }),
      maxTotalClaims: whole(1, 10_000_000, { default: null }),
      // Budget: the most coins this campaign may give out in total.
      maxTotalCoins: whole(1, COIN_LIMITS.maxCoinsPerOperation * 100, { default: null }),
    },
    stats: {
      claims: { type: Number, default: 0, min: 0 },
      coins: { type: Number, default: 0, min: 0 },
    },
    createdBy: { type: ObjectId, ref: "User" },
    updatedBy: { type: ObjectId, ref: "User" },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = String(ret._id);
        delete ret._id;
        return ret;
      },
    },
  },
);

campaignSchema.pre("validate", function checkDates() {
  if (this.startAt && this.endAt && this.endAt <= this.startAt)
    this.invalidate("endAt", "The end must be after the start");
  if (this.coinsExpireAt && this.endAt && this.coinsExpireAt <= this.endAt)
    this.invalidate("coinsExpireAt", "Coins must stay valid until after the campaign ends");
});

campaignSchema.index({ status: 1, startAt: 1, endAt: 1 });
campaignSchema.index({ status: 1, trigger: 1 });
campaignSchema.index({ createdAt: -1 });

export const RewardCampaign = mongoose.model("RewardCampaign", campaignSchema);

export const CLAIM_STATUS = Object.freeze({ PENDING: "PENDING", ISSUED: "ISSUED" });

/**
 * One reward given to one customer: a campaign claim, a birthday or a welcome bonus. `claimKey` is
 * unique, so the same reward can never be claimed twice (welcome:<user>, birthday:<user>:<year>,
 * campaign:<id>:<user>:<n>). PENDING means the coins are being credited (the sweep finishes it).
 */
const claimSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    campaign: { type: ObjectId, ref: "RewardCampaign", default: null },
    rewardType: { type: String, enum: Object.values(REWARD_TYPES), required: true },
    coins: whole(1, COIN_LIMITS.maxRewardCoins, { required: true }),
    status: { type: String, enum: Object.values(CLAIM_STATUS), default: CLAIM_STATUS.PENDING },
    order: { type: ObjectId, ref: "Order", default: null },
    txn: { type: ObjectId, ref: "CoinTransaction", default: null },
    claimKey: { type: String, required: true, maxlength: 200 },
    issuedAt: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: "claimedAt", updatedAt: true },
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.claimKey;
        return ret;
      },
    },
  },
);

claimSchema.index({ claimKey: 1 }, { unique: true });
claimSchema.index({ user: 1, claimedAt: -1 });
claimSchema.index({ campaign: 1, user: 1 });
claimSchema.index({ campaign: 1, claimedAt: -1 });
// One reward per campaign per order.
claimSchema.index(
  { campaign: 1, order: 1 },
  { unique: true, partialFilterExpression: { campaign: { $type: "objectId" }, order: { $type: "objectId" } } },
);
claimSchema.index({ status: 1, updatedAt: 1 });

export const RewardClaim = mongoose.model("RewardClaim", claimSchema);
