import { body, header, param, query } from "express-validator";
import {
  COIN_LIMITS,
  COIN_SOURCES,
  COIN_TXN_TYPES,
  DEFAULT_REWARD_CONFIG,
} from "../config/rewards.js";
import {
  REFERRAL_REWARD_STATUS,
  REFERRAL_STATUS,
} from "../models/referral.model.js";
import {
  CAMPAIGN_STATUS,
  CAMPAIGN_TRIGGERS,
  CAMPAIGN_TYPES,
  CUSTOMER_GROUPS,
  REWARD_TYPES,
} from "../models/reward-campaign.model.js";
import { paginationRules } from "./common.validators.js";

export const cartCoinsRules = [
  body("coins")
    .isInt({ min: 0, max: COIN_LIMITS.maxCoinsPerOperation })
    .withMessage("Coins must be a whole number")
    .toInt(),
];

export const coinTransactionListRules = [
  ...paginationRules,
  query("type").optional().isIn(Object.values(COIN_TXN_TYPES)).withMessage("Unknown type"),
  query("source").optional().isIn(Object.values(COIN_SOURCES)).withMessage("Unknown source"),
];

export const referralCodeRules = [
  body("code")
    .isString()
    .trim()
    .toUpperCase()
    .isLength({ min: 4, max: 40 })
    .withMessage("Enter a referral code"),
];

export const referralHistoryRules = [
  ...paginationRules,
  query("status")
    .optional()
    // What customers see: every stage except the never-stored PENDING, and REJECTED shown as NOT_ELIGIBLE.
    .isIn([
      ...Object.values(REFERRAL_STATUS).filter((s) => s !== "PENDING" && s !== "REJECTED"),
      "NOT_ELIGIBLE",
    ])
    .withMessage("Unknown status"),
];

export const birthdayRules = [
  body("birthDate")
    .isString()
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage("Enter the date as YYYY-MM-DD"),
];

export const rewardHistoryRules = [
  ...paginationRules,
  query("rewardType")
    .optional()
    .isIn(Object.values(REWARD_TYPES))
    .withMessage("Unknown reward type"),
];

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** Every reward setting as a body rule (unknown fields are dropped by validate()). Ranges: the model. */
function settingRules(value, path = "") {
  return Object.entries(value).flatMap(([key, v]) => {
    const p = path ? `${path}.${key}` : key;
    if (Array.isArray(v))
      return [body(p).optional().isArray({ max: 10 }), body(`${p}.*`).isString().trim()];
    if (v !== null && typeof v === "object") return settingRules(v, p);
    if (typeof v === "boolean") return [body(p).optional().isBoolean({ strict: true }).withMessage(`${p} must be true or false`)];
    if (typeof v === "number")
      return [body(p).optional().isInt({ min: 0, max: 1_000_000_000 }).withMessage(`${p} must be a whole number`).toInt()];
    return [body(p).optional().isString().trim().isLength({ max: 60 })];
  });
}

export const updateConfigRules = [
  body("version").isInt({ min: 0 }).withMessage("Send the version you loaded").toInt(),
  ...settingRules(DEFAULT_REWARD_CONFIG),
];

const nullableInt = (field, min, max) =>
  body(field)
    .optional()
    .custom((v) => v === null || (Number.isInteger(v) && v >= min && v <= max))
    .withMessage(`${field} must be empty or a whole number from ${min}`);

const campaignFields = (required) => {
  const need = (chain) => (required ? chain : chain.optional());
  return [
    need(body("name")).isString().trim().isLength({ min: 3, max: 80 }).withMessage("Name: 3 to 80 characters"),
    body("description").optional().isString().trim().isLength({ max: 500 }),
    need(body("type")).isIn(Object.values(CAMPAIGN_TYPES)).withMessage("Choose festival or promotional"),
    body("trigger").optional().isIn(Object.values(CAMPAIGN_TRIGGERS)),
    need(body("rewardCoins")).isInt({ min: 1, max: COIN_LIMITS.maxRewardCoins }).withMessage("Reward: a whole number of coins").toInt(),
    need(body("startAt")).isISO8601().withMessage("Start: a date and time").toDate(),
    need(body("endAt")).isISO8601().withMessage("End: a date and time").toDate(),
    body("timezone").optional().isString().trim().isLength({ max: 60 }),
    body("conditions.customerGroup").optional().isIn(Object.values(CUSTOMER_GROUPS)),
    body("conditions.inactiveDays").optional().isInt({ min: 1, max: 3650 }).toInt(),
    body("conditions.minOrderPaise").optional().isInt({ min: 0, max: 100_000_000 }).toInt(),
    body("conditions.firstOrderOnly").optional().isBoolean({ strict: true }),
    body("conditions.restaurants").optional().isArray({ max: 100 }),
    body("conditions.restaurants.*").isMongoId().withMessage("Invalid restaurant"),
    body("limits.maxClaimsPerCustomer").optional().isInt({ min: 1, max: 1000 }).toInt(),
    nullableInt("limits.maxTotalClaims", 1, 10_000_000),
    nullableInt("limits.maxTotalCoins", 1, COIN_LIMITS.maxCoinsPerOperation * 100),
  ];
};

export const createCampaignRules = campaignFields(true);
export const updateCampaignRules = [param("id").isMongoId(), ...campaignFields(false)];
export const campaignStatusRules = [
  param("id").isMongoId(),
  body("action").isIn(["activate", "pause", "end"]).withMessage("Choose activate, pause or end"),
];
export const campaignListRules = [
  ...paginationRules,
  query("status").optional().isIn(Object.values(CAMPAIGN_STATUS)),
  query("type").optional().isIn(Object.values(CAMPAIGN_TYPES)),
  query("search").optional().isString().trim().isLength({ max: 100 }),
];
export const claimListRules = [
  ...paginationRules,
  query("rewardType").optional().isIn(Object.values(REWARD_TYPES)),
  query("campaign").optional().isMongoId(),
];

export const adminTransactionListRules = [
  ...coinTransactionListRules,
  query("search").optional().isString().trim().isLength({ max: 100 }),
  query("userId").optional().isMongoId(),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
];

export const reverseTransactionRules = [
  param("id").isMongoId(),
  header("idempotency-key")
    .isString()
    .matches(/^[A-Za-z0-9_-]{8,100}$/)
    .withMessage("Send an Idempotency-Key header (8-100 letters, digits, - or _)"),
  body("coins").optional().isInt({ min: 1, max: COIN_LIMITS.maxCoinsPerOperation }).toInt(),
  body("reason").isString().trim().isLength({ min: 3, max: 300 }).withMessage("Give a reason (3-300 characters)"),
];

export const adminReferralListRules = [
  ...paginationRules,
  query("status").optional().isIn(Object.values(REFERRAL_STATUS)),
  query("rewardStatus").optional().isIn(Object.values(REFERRAL_REWARD_STATUS)),
  query("flagged").optional().isBoolean().toBoolean(),
  query("search").optional().isString().trim().isLength({ max: 100 }),
];
export const referralDecisionRules = (noteRequired) => [
  param("id").isMongoId(),
  (noteRequired ? body("note") : body("note").optional())
    .isString()
    .trim()
    .isLength({ min: noteRequired ? 3 : 0, max: 300 })
    .withMessage("Add a note (up to 300 characters)"),
];
