import mongoose from "mongoose";
import { logger } from "../config/logger.js";
import { COIN_SOURCES } from "../config/rewards.js";
import { ORDER_STATUS, Order } from "../models/order.model.js";
import {
  CAMPAIGN_STATUS as CS,
  CAMPAIGN_TRIGGERS,
  CAMPAIGN_TYPES,
  CLAIM_STATUS,
  CUSTOMER_GROUPS as G,
  REWARD_TYPES,
  RewardCampaign,
  RewardClaim,
} from "../models/reward-campaign.model.js";
import { ROLES, USER_STATUS, User } from "../models/user.model.js";
import { ApiError } from "../utils/api-error.js";
import { DAY_MS, localDate } from "../utils/dates.js";
import { personView } from "../utils/people.js";
import { escapeRegex, paginationMeta } from "../utils/pagination.js";
import * as wallet from "./coin-wallet.service.js";
import { foodValuePaise, ruleOn } from "./coins.service.js";
import { notify } from "./notification.service.js";
import { getRewardConfig } from "./reward-config.service.js";

/**
 * Special rewards: welcome and birthday bonuses (configured globally) and festival / promotional
 * campaigns (created by the super admin). Every reward is a RewardClaim with a unique key, then a
 * ledger credit keyed by the claim, so nothing can be paid twice.
 */

const SOURCE_FOR = {
  [REWARD_TYPES.WELCOME]: COIN_SOURCES.WELCOME_REWARD,
  [REWARD_TYPES.BIRTHDAY]: COIN_SOURCES.BIRTHDAY_REWARD,
  [REWARD_TYPES.FESTIVAL]: COIN_SOURCES.FESTIVAL_REWARD,
  [REWARD_TYPES.PROMOTIONAL]: COIN_SOURCES.PROMOTIONAL_REWARD,
};
const conflict = (message, code) => ApiError.conflict(message, code);

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** Credits a claim's coins and marks it issued. Safe to repeat (sweep recovery). */
/** `campaign`: a campaign's own coin expiry date wins over the settings' expiry period. */
async function issue(claim, { description, title, link = "/account/rewards", campaign = null }) {
  const { txn, created } = await wallet.credit(claim.user, {
    coins: claim.coins,
    source: SOURCE_FOR[claim.rewardType],
    key: `claim:${claim.claimKey}`,
    campaign: claim.campaign ?? undefined,
    order: claim.order ?? undefined,
    description,
    expiresAt: campaign?.coinsExpireAt ?? undefined,
  });
  const issued = await RewardClaim.findOneAndUpdate(
    { _id: claim._id, status: CLAIM_STATUS.PENDING },
    { $set: { status: CLAIM_STATUS.ISSUED, txn: txn._id, issuedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (created && title) await notify(claim.user, { type: "coins.reward", title, body: description, link });
  return issued ?? RewardClaim.findById(claim._id);
}

/** Creates a claim with a unique key. Returns { claim, created }; an existing key returns it. */
async function createClaim(fields) {
  try {
    const [claim] = await RewardClaim.create([{ ...fields, status: CLAIM_STATUS.PENDING }]);
    return { claim, created: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await RewardClaim.findOne({ claimKey: fields.claimKey });
    if (existing) return { claim: existing, created: false };
    // Same campaign + order under another key: that order already earned this campaign.
    return { claim: null, created: false, duplicateOrder: true };
  }
}

/** A one-off reward (welcome, birthday). Idempotent by key. */
async function grantOnce({ userId, rewardType, coins, key, description, title }) {
  const { claim } = await createClaim({ user: userId, rewardType, coins, claimKey: key });
  if (claim.status === CLAIM_STATUS.ISSUED) return claim;
  return issue(claim, { description, title });
}

// ---------------------------------------------------------------------------
// Welcome and birthday
// ---------------------------------------------------------------------------

const welcomeKey = (userId) => `welcome:${userId}`;
const birthdayKey = (userId, year) => `birthday:${userId}:${year}`;

/** Called on sign-up and on delivered orders; pays the welcome bonus at the configured moment. */
export async function maybeWelcome(userId, moment) {
  const config = await getRewardConfig();
  const rule = config.welcome;
  if (!ruleOn(config, rule) || !rule.coins || rule.trigger !== moment) return null;
  // Called on every delivered order: skip the insert attempt once the bonus was paid.
  const paid = await RewardClaim.exists({ claimKey: welcomeKey(userId), status: CLAIM_STATUS.ISSUED });
  if (paid) return null;
  return grantOnce({
    userId,
    rewardType: REWARD_TYPES.WELCOME,
    coins: rule.coins,
    key: welcomeKey(userId),
    description: "Welcome to BiteBox",
    title: `Welcome! ${rule.coins} coins are in your wallet`,
  });
}

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Birthday sweep: everyone whose birthday is today (in the configured zone) gets the bonus once a year. */
export async function birthdaySweep({ now = new Date(), limit = 500 } = {}) {
  const config = await getRewardConfig();
  const rule = config.birthday;
  if (!ruleOn(config, rule) || !rule.coins) return { issued: 0 };
  const { year, month, day } = localDate(now, config.timezone);
  // 29 February birthdays are celebrated on 28 February in other years.
  const days = month === 2 && day === 28 && !isLeap(year) ? [28, 29] : [day];
  const users = await User.find({
    role: ROLES.CUSTOMER,
    status: USER_STATUS.ACTIVE,
    birthDate: { $type: "date" },
    $expr: {
      $and: [
        { $eq: [{ $month: "$birthDate" }, month] },
        { $in: [{ $dayOfMonth: "$birthDate" }, days] },
      ],
    },
  })
    .select("_id")
    .limit(limit)
    .lean();
  const keys = users.map((u) => birthdayKey(u._id, year));
  const done = new Set(
    (await RewardClaim.find({ claimKey: { $in: keys }, status: CLAIM_STATUS.ISSUED }).select("claimKey").lean()).map(
      (c) => c.claimKey,
    ),
  );
  let issued = 0;
  for (const user of users) {
    const key = birthdayKey(user._id, year);
    if (done.has(key)) continue;
    try {
      await grantOnce({
        userId: user._id,
        rewardType: REWARD_TYPES.BIRTHDAY,
        coins: rule.coins,
        key,
        description: "Happy birthday from BiteBox",
        title: `Happy birthday! ${rule.coins} coins are in your wallet`,
      });
      issued++;
    } catch (err) {
      logger.error({ err, userId: String(user._id) }, "Birthday reward failed");
    }
  }
  return { issued };
}

/** The customer sets their date of birth, once (support can correct it). */
export async function setBirthDate(userId, isoDate, now = new Date()) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    throw new ApiError(422, "Enter a valid date", { code: "VALIDATION_ERROR", details: [{ field: "birthDate", message: "Enter a valid date" }] });
  const age = (now - date) / (365.25 * DAY_MS);
  if (age < 13 || age > 120)
    throw new ApiError(422, "Enter your real date of birth", { code: "VALIDATION_ERROR", details: [{ field: "birthDate", message: "Enter your real date of birth" }] });
  const updated = await User.findOneAndUpdate(
    { _id: userId, role: ROLES.CUSTOMER, birthDate: { $exists: false } },
    { $set: { birthDate: date } },
    { returnDocument: "after" },
  );
  if (!updated)
    throw conflict("Your birthday is already saved. Contact support to change it.", "BIRTHDAY_SET");
  return { birthDate: isoDate };
}

// ---------------------------------------------------------------------------
// Campaign eligibility
// ---------------------------------------------------------------------------

/** Delivered-order history used by customer groups (optionally ignoring one order). */
/** The customer's latest delivered order (optionally ignoring one): all customer groups need. */
async function orderHistory(userId, excludeOrderId = null) {
  const filter = { customer: userId, status: ORDER_STATUS.DELIVERED };
  if (excludeOrderId) filter._id = { $ne: excludeOrderId };
  const last = await Order.findOne(filter).sort({ createdAt: -1 }).select("createdAt").lean();
  return { ordered: Boolean(last), lastAt: last?.createdAt ?? null };
}

/** Loads the order history at most once, and only if a campaign needs it. */
const lazyHistory = (userId) => {
  let loaded;
  return () => (loaded ??= orderHistory(userId));
};

function groupOk(conditions, history, now) {
  switch (conditions.customerGroup) {
    case G.NEW:
      return !history.ordered;
    case G.EXISTING:
      return history.ordered;
    case G.INACTIVE:
      return history.ordered && history.lastAt < new Date(now.getTime() - conditions.inactiveDays * DAY_MS);
    default:
      return true;
  }
}

const GROUP_REASON = {
  [G.NEW]: "For customers who have not ordered yet",
  [G.EXISTING]: "For customers who have ordered before",
  [G.INACTIVE]: "For customers who have not ordered for a while",
};

const isRunning = (c, now) => c.status === CS.ACTIVE && c.startAt <= now && c.endAt > now;

/** Why a customer cannot claim (null when they can). Customer-safe wording. */
async function claimBlocker(campaign, history, now, used) {
  if (campaign.trigger !== CAMPAIGN_TRIGGERS.CLAIM) return "Earned automatically with a qualifying order";
  if (!isRunning(campaign, now)) return campaign.startAt > now ? "Not started yet" : "This offer has ended";
  if (used >= campaign.limits.maxClaimsPerCustomer) return "Already claimed";
  if (campaign.limits.maxTotalClaims !== null && campaign.stats.claims >= campaign.limits.maxTotalClaims)
    return "All rewards have been claimed";
  if (campaign.limits.maxTotalCoins !== null && campaign.stats.coins + campaign.rewardCoins > campaign.limits.maxTotalCoins)
    return "All rewards have been claimed";
  if (campaign.conditions.customerGroup !== G.ALL && !groupOk(campaign.conditions, await history(), now))
    return GROUP_REASON[campaign.conditions.customerGroup];
  return null;
}

/**
 * Takes one claim slot of a campaign for a customer, then pays it. Limits are enforced atomically:
 * the campaign counters only move while under their limits, and the per-customer claim number is
 * part of the unique claim key.
 */
async function claimCampaign(campaign, userId, { order = null, now = new Date() } = {}) {
  const config = await getRewardConfig();
  if (!config.coinsEnabled) throw conflict("Rewards are paused right now", "REWARDS_PAUSED");
  for (let attempt = 0; attempt < 5; attempt++) {
    const used = await RewardClaim.countDocuments({ campaign: campaign._id, user: userId });
    if (used >= campaign.limits.maxClaimsPerCustomer) throw conflict("You have already claimed this reward", "ALREADY_CLAIMED");

    const counted = await RewardCampaign.findOneAndUpdate(
      {
        _id: campaign._id,
        status: CS.ACTIVE,
        startAt: { $lte: now },
        endAt: { $gt: now },
        $and: [
          { $or: [{ "limits.maxTotalClaims": null }, { $expr: { $lt: ["$stats.claims", "$limits.maxTotalClaims"] } }] },
          {
            $or: [
              { "limits.maxTotalCoins": null },
              { $expr: { $lte: [{ $add: ["$stats.coins", "$rewardCoins"] }, "$limits.maxTotalCoins"] } },
            ],
          },
        ],
      },
      { $inc: { "stats.claims": 1, "stats.coins": campaign.rewardCoins } },
      { returnDocument: "after" },
    );
    if (!counted) throw conflict("This reward is no longer available", "CAMPAIGN_UNAVAILABLE");

    const { claim, created, duplicateOrder } = await createClaim({
      user: userId,
      campaign: campaign._id,
      rewardType: campaign.type === CAMPAIGN_TYPES.FESTIVAL ? REWARD_TYPES.FESTIVAL : REWARD_TYPES.PROMOTIONAL,
      coins: campaign.rewardCoins,
      order,
      claimKey: `campaign:${campaign._id}:${userId}:${used + 1}`,
    });
    if (!created) {
      // Lost a race for this slot (or this order already earned it): give the counter back.
      await RewardCampaign.updateOne(
        { _id: campaign._id },
        { $inc: { "stats.claims": -1, "stats.coins": -campaign.rewardCoins } },
      );
      if (duplicateOrder) return null;
      continue;
    }
    await completeIfFull(counted);
    return issue(claim, {
      campaign,
      description: campaign.name,
      title: `You earned ${campaign.rewardCoins} coins`,
    });
  }
  throw conflict("Please try again", "CLAIM_BUSY");
}

async function completeIfFull(c) {
  const claimsFull = c.limits.maxTotalClaims !== null && c.stats.claims >= c.limits.maxTotalClaims;
  const coinsFull = c.limits.maxTotalCoins !== null && c.stats.coins + c.rewardCoins > c.limits.maxTotalCoins;
  if (claimsFull || coinsFull)
    await RewardCampaign.updateOne({ _id: c._id, status: CS.ACTIVE }, { $set: { status: CS.COMPLETED } });
}

/** POST /rewards/campaigns/:id/claim */
export async function claim(userId, campaignId, now = new Date()) {
  const campaign = await RewardCampaign.findOne({ _id: campaignId, status: { $ne: CS.DRAFT } });
  if (!campaign) throw ApiError.notFound("Reward not found");
  const used = await RewardClaim.countDocuments({ campaign: campaign._id, user: userId });
  const blocker = await claimBlocker(campaign, lazyHistory(userId), now, used);
  if (blocker) throw conflict(blocker, "NOT_ELIGIBLE");
  const issued = await claimCampaign(campaign, userId, { now });
  return { claim: claimView(issued, campaign) };
}

/** Delivered order: pays every running ORDER campaign it qualifies for (each once per order). */
export async function onOrderDelivered(order, now = new Date()) {
  const campaigns = await RewardCampaign.find({
    status: CS.ACTIVE,
    trigger: CAMPAIGN_TRIGGERS.ORDER,
    startAt: { $lte: order.createdAt },
    endAt: { $gt: now },
  });
  if (!campaigns.length) return [];
  const history = await orderHistory(order.customer, order._id);
  const food = foodValuePaise(order.pricing);
  const paid = [];
  for (const campaign of campaigns) {
    const c = campaign.conditions;
    if (order.createdAt >= campaign.endAt) continue;
    if (food < c.minOrderPaise) continue;
    if (c.firstOrderOnly && history.ordered) continue;
    if (c.restaurants.length && !c.restaurants.some((r) => String(r) === String(order.restaurant))) continue;
    if (!groupOk(c, history, now)) continue;
    try {
      const claimed = await claimCampaign(campaign, order.customer, { order: order._id, now });
      if (claimed) paid.push(claimed);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error; // limits reached: simply not rewarded
    }
  }
  return paid;
}

// ---------------------------------------------------------------------------
// Sweep: schedules and recovery
// ---------------------------------------------------------------------------

export async function campaignSweep({ now = new Date(), limit = 200 } = {}) {
  const started = await RewardCampaign.updateMany(
    { status: CS.SCHEDULED, startAt: { $lte: now }, endAt: { $gt: now } },
    { $set: { status: CS.ACTIVE } },
  );
  const ended = await RewardCampaign.updateMany(
    { status: { $in: [CS.SCHEDULED, CS.ACTIVE, CS.PAUSED] }, endAt: { $lte: now } },
    { $set: { status: CS.EXPIRED } },
  );
  // Claims a crash left between "claimed" and "credited".
  const pending = await RewardClaim.find({
    status: CLAIM_STATUS.PENDING,
    updatedAt: { $lte: new Date(now.getTime() - 5 * 60_000) },
  }).limit(limit);
  let recovered = 0;
  for (const c of pending) {
    try {
      const campaign = c.campaign ? await RewardCampaign.findById(c.campaign).select("name coinsExpireAt") : null;
      await issue(c, { campaign, description: campaign?.name ?? `${c.rewardType.toLowerCase()} reward` });
      recovered++;
    } catch (err) {
      logger.error({ err, claimId: String(c._id) }, "Could not finish a reward claim");
    }
  }
  return { started: started.modifiedCount, ended: ended.modifiedCount, recovered };
}

// ---------------------------------------------------------------------------
// Customer views
// ---------------------------------------------------------------------------

function claimView(claim, campaign) {
  return {
    id: String(claim._id),
    rewardType: claim.rewardType,
    coins: claim.coins,
    status: claim.status,
    campaign: campaign ? { id: String(campaign._id), name: campaign.name } : null,
    orderId: claim.order ? String(claim.order) : null,
    claimedAt: claim.claimedAt,
  };
}

function campaignForCustomer(c, used, blocker) {
  return {
    id: String(c._id),
    name: c.name,
    description: c.description,
    type: c.type,
    trigger: c.trigger,
    rewardCoins: c.rewardCoins,
    startAt: c.startAt,
    endAt: c.endAt,
    coinsExpireAt: c.coinsExpireAt ?? null,
    status: c.status === CS.ACTIVE && c.startAt > new Date() ? CS.SCHEDULED : c.status,
    conditions: {
      minOrderPaise: c.conditions.minOrderPaise,
      firstOrderOnly: c.conditions.firstOrderOnly,
      restaurantOnly: c.conditions.restaurants.length > 0,
    },
    claimedTimes: used,
    maxClaimsPerCustomer: c.limits.maxClaimsPerCustomer,
    canClaim: !blocker,
    reason: blocker,
  };
}

/** Running and upcoming (next 30 days) campaigns, with what this customer can do. */
export async function customerCampaigns(userId, now = new Date()) {
  const campaigns = await RewardCampaign.find({
    status: { $in: [CS.ACTIVE, CS.SCHEDULED] },
    endAt: { $gt: now },
    startAt: { $lte: new Date(now.getTime() + 30 * DAY_MS) },
  })
    .sort({ endAt: 1 })
    .limit(50);
  const counts = await RewardClaim.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(String(userId)), campaign: { $in: campaigns.map((c) => c._id) } } },
    { $group: { _id: "$campaign", n: { $sum: 1 } } },
  ]);
  const used = new Map(counts.map((c) => [String(c._id), c.n]));
  const history = lazyHistory(userId);
  const items = await Promise.all(
    campaigns.map(async (c) => {
      const n = used.get(String(c._id)) ?? 0;
      return campaignForCustomer(c, n, await claimBlocker(c, history, now, n));
    }),
  );
  return { items };
}

/** The Special Rewards page header: birthday, welcome and totals. */
export async function overview(userId, now = new Date()) {
  const [config, user, totals, welcome] = await Promise.all([
    getRewardConfig(),
    User.findById(userId).select("birthDate").lean(),
    RewardClaim.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(String(userId)), status: CLAIM_STATUS.ISSUED } },
      { $group: { _id: null, claims: { $sum: 1 }, coins: { $sum: "$coins" } } },
    ]),
    RewardClaim.findOne({ claimKey: welcomeKey(userId) }).lean(),
  ]);
  const { year, month, day } = localDate(now, config.timezone);
  let birthday = null;
  if (user?.birthDate) {
    const bMonth = user.birthDate.getUTCMonth() + 1;
    const bDay = user.birthDate.getUTCDate();
    const passed = bMonth < month || (bMonth === month && bDay < day);
    const nextYear = passed ? year + 1 : year;
    const nextDay = bMonth === 2 && bDay === 29 && !isLeap(nextYear) ? 28 : bDay;
    const claimed = await RewardClaim.exists({ claimKey: birthdayKey(userId, year) });
    birthday = {
      birthDate: user.birthDate.toISOString().slice(0, 10),
      next: `${nextYear}-${String(bMonth).padStart(2, "0")}-${String(nextDay).padStart(2, "0")}`,
      claimedThisYear: Boolean(claimed),
    };
  }
  const on = config.coinsEnabled;
  return {
    enabled: on,
    birthday: {
      enabled: on && config.birthday.enabled,
      coins: config.birthday.coins,
      ...birthday,
      saved: Boolean(birthday),
    },
    welcome: {
      enabled: on && config.welcome.enabled,
      coins: config.welcome.coins,
      trigger: config.welcome.trigger,
      claimed: welcome?.status === CLAIM_STATUS.ISSUED,
    },
    totals: { claims: totals[0]?.claims ?? 0, coins: totals[0]?.coins ?? 0 },
  };
}

export async function history(userId, { rewardType } = {}, pagination) {
  const filter = { user: userId };
  if (rewardType) filter.rewardType = rewardType;
  const [items, total] = await Promise.all([
    RewardClaim.find(filter)
      .sort({ claimedAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .populate("campaign", "name"),
    RewardClaim.countDocuments(filter),
  ]);
  return {
    items: items.map((c) => claimView(c, c.campaign)),
    pagination: paginationMeta(pagination, total),
  };
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

const EDITABLE = ["name", "description", "type", "trigger", "rewardCoins", "startAt", "endAt", "coinsExpireAt", "timezone", "conditions", "limits"];
// Running campaigns keep their promise to customers: only wording, the dates and limits change
// (a new coin expiry applies to coins given from then on).
const EDITABLE_WHILE_RUNNING = ["name", "description", "endAt", "coinsExpireAt", "limits"];

function pick(input, fields) {
  const out = {};
  for (const f of fields) if (input[f] !== undefined) out[f] = input[f];
  return out;
}

function validationError(error) {
  if (error instanceof mongoose.Error.ValidationError)
    return new ApiError(422, "Validation failed", {
      code: "VALIDATION_ERROR",
      details: Object.values(error.errors).map((e) => ({ field: e.path, message: e.message })),
    });
  return error;
}

export async function adminCreate(admin, input) {
  try {
    const [campaign] = await RewardCampaign.create([
      { ...pick(input, EDITABLE), status: CS.DRAFT, createdBy: admin._id, updatedBy: admin._id },
    ]);
    return adminView(campaign);
  } catch (error) {
    throw validationError(error);
  }
}

export async function adminUpdate(admin, id, input) {
  const campaign = await RewardCampaign.findById(id);
  if (!campaign) throw ApiError.notFound("Campaign not found");
  if ([CS.EXPIRED, CS.COMPLETED].includes(campaign.status))
    throw conflict("Finished campaigns cannot be edited", "CAMPAIGN_FINISHED");
  const fields = campaign.status === CS.ACTIVE ? EDITABLE_WHILE_RUNNING : EDITABLE;
  const blocked = Object.keys(input).filter((k) => EDITABLE.includes(k) && !fields.includes(k));
  if (blocked.length)
    throw conflict(`Pause the campaign to change: ${blocked.join(", ")}`, "CAMPAIGN_RUNNING");
  const changes = pick(input, fields);
  for (const [key, value] of Object.entries(changes)) {
    if (key === "conditions" || key === "limits") {
      for (const [k, v] of Object.entries(value)) campaign.set(`${key}.${k}`, v);
    } else campaign.set(key, value);
  }
  campaign.updatedBy = admin._id;
  try {
    await campaign.save();
  } catch (error) {
    throw validationError(error);
  }
  return adminView(campaign);
}

/** activate (-> SCHEDULED or ACTIVE), pause, or end (-> COMPLETED). */
export async function adminSetStatus(admin, id, action, now = new Date()) {
  const campaign = await RewardCampaign.findById(id);
  if (!campaign) throw ApiError.notFound("Campaign not found");
  const moves = {
    activate: { from: [CS.DRAFT, CS.PAUSED] },
    pause: { from: [CS.ACTIVE, CS.SCHEDULED] },
    end: { from: [CS.DRAFT, CS.SCHEDULED, CS.ACTIVE, CS.PAUSED] },
  };
  const move = moves[action];
  if (!move.from.includes(campaign.status))
    throw conflict(`A ${campaign.status.toLowerCase()} campaign cannot be ${action === "end" ? "ended" : action + "d"}`, "INVALID_CAMPAIGN_MOVE");
  let to;
  if (action === "activate") {
    if (campaign.endAt <= now) throw conflict("The end date has passed. Change it first.", "CAMPAIGN_ENDED");
    to = campaign.startAt > now ? CS.SCHEDULED : CS.ACTIVE;
  } else to = action === "pause" ? CS.PAUSED : CS.COMPLETED;
  const updated = await RewardCampaign.findOneAndUpdate(
    { _id: id, status: campaign.status },
    { $set: { status: to, updatedBy: admin._id } },
    { returnDocument: "after" },
  );
  if (!updated) throw conflict("The campaign was just changed. Refresh and try again.", "CAMPAIGN_CHANGED");
  return adminView(updated);
}

function adminView(c) {
  const json = c.toJSON();
  return {
    ...json,
    remainingClaims: c.limits.maxTotalClaims === null ? null : Math.max(0, c.limits.maxTotalClaims - c.stats.claims),
    remainingCoins: c.limits.maxTotalCoins === null ? null : Math.max(0, c.limits.maxTotalCoins - c.stats.coins),
  };
}

export async function adminList({ status, type, search }, pagination) {
  const filter = {};
  if (status) filter.status = status;
  if (type) filter.type = type;
  if (search) filter.name = new RegExp(escapeRegex(search), "i");
  const [items, total] = await Promise.all([
    RewardCampaign.find(filter).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit),
    RewardCampaign.countDocuments(filter),
  ]);
  return { items: items.map(adminView), pagination: paginationMeta(pagination, total) };
}

export async function adminGet(id) {
  const campaign = await RewardCampaign.findById(id).populate("conditions.restaurants", "name slug");
  if (!campaign) throw ApiError.notFound("Campaign not found");
  const recent = await RewardClaim.find({ campaign: id })
    .sort({ claimedAt: -1 })
    .limit(20)
    .populate("user", "name email")
    .lean();
  const customers = await RewardClaim.distinct("user", { campaign: id });
  return {
    campaign: adminView(campaign),
    performance: {
      claims: campaign.stats.claims,
      coins: campaign.stats.coins,
      customers: customers.length,
    },
    recentClaims: recent.map((c) => ({
      id: String(c._id),
      customer: personView(c.user),
      coins: c.coins,
      status: c.status,
      orderId: c.order ? String(c.order) : null,
      claimedAt: c.claimedAt,
    })),
  };
}

/** Every reward claim (welcome, birthday, campaigns), newest first: the distribution history. */
export async function adminClaims({ rewardType, campaign }, pagination) {
  const filter = {};
  if (rewardType) filter.rewardType = rewardType;
  if (campaign) filter.campaign = campaign;
  const [items, total] = await Promise.all([
    RewardClaim.find(filter)
      .sort({ claimedAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .populate("user", "name email")
      .populate("campaign", "name"),
    RewardClaim.countDocuments(filter),
  ]);
  return {
    items: items.map((c) => ({
      ...claimView(c, c.campaign),
      customer: personView(c.user),
    })),
    pagination: paginationMeta(pagination, total),
  };
}

