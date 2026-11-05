import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { PERMISSIONS } from "../config/permissions.js";
import { COIN_SOURCES } from "../config/rewards.js";
import { Address } from "../models/address.model.js";
import { ORDER_STATUS, Order } from "../models/order.model.js";
import {
  REFERRAL_REWARD_STATUS as RS,
  REFERRAL_RISK,
  REFERRAL_STATUS as R,
  Referral,
  ReferralRewardCounter,
} from "../models/referral.model.js";
import { Session } from "../models/session.model.js";
import { ROLES, USER_STATUS, User } from "../models/user.model.js";
import { ApiError } from "../utils/api-error.js";
import { randomChars } from "../utils/codes.js";
import { DAY_MS, localMonth } from "../utils/dates.js";
import { haversineMeters } from "../utils/geo.js";
import { matchingUserIds, personView } from "../utils/people.js";
import { escapeRegex, paginationMeta } from "../utils/pagination.js";
import * as wallet from "./coin-wallet.service.js";
import { foodValuePaise, ruleOn } from "./coins.service.js";
import { notify, notifyAdmins } from "./notification.service.js";
import { getRewardConfig } from "./reward-config.service.js";

/**
 * Refer & earn. A customer shares their code; a friend signs up with it (REGISTERED), places a first
 * order (FIRST_ORDER_PLACED) and has it delivered within the attribution window (ORDER_DELIVERED).
 * Then both are rewarded (REWARD_CREDITED), unless a risk signal holds it for an admin.
 * Everything is decided here from server data; the client only ever sends the code.
 */

// Delivery points closer than this count as "the same address".
const SAME_PLACE_METERS = 100;
// More sign-ups than this with one code in a day is unusual.
const VELOCITY_PER_DAY = 5;

const invalidCode = (message = "This referral code is not valid") =>
  new ApiError(422, message, {
    code: "REFERRAL_INVALID",
    details: [{ field: "referralCode", message }],
  });

const referralRewardKey = (referralId, who) => `referral:${referralId}:${who}`;
const referralLink = (code) => `${env.clientUrls[0]}/register?ref=${encodeURIComponent(code)}`;

const normalise = (code) => String(code ?? "").trim().toUpperCase();

/** BITEBOX-RIYA7K2Q: up to 5 letters of the first name plus 4 random characters. */
export function generateCode(name) {
  const letters =
    String(name ?? "")
      .normalize("NFKD")
      .toUpperCase()
      .split(/\s+/)[0]
      .replace(/[^A-Z]/g, "")
      .slice(0, 5) || "FRIEND";
  return `BITEBOX-${letters}${randomChars(4)}`;
}

/** The customer's code, created on first use. Unique in the database (retries on a clash). */
export async function ensureReferralCode(userId) {
  const user = await User.findById(userId).select("name role referralCode");
  if (!user) throw ApiError.notFound("Account not found");
  if (user.referralCode) return user.referralCode;
  if (user.role !== ROLES.CUSTOMER) throw ApiError.forbidden("Only customers can refer friends");
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await User.updateOne(
        { _id: user._id, referralCode: { $exists: false } },
        { $set: { referralCode: generateCode(user.name) } },
      );
      break;
    } catch (error) {
      if (error?.code !== 11000) throw error; // code taken: try another
    }
  }
  const saved = await User.findById(user._id).select("referralCode");
  if (!saved.referralCode) throw new Error("Could not create a referral code");
  return saved.referralCode;
}

/** The referrer behind a code, if the code can be used now. Throws REFERRAL_INVALID otherwise. */
export async function resolveCode(rawCode, config = null) {
  const code = normalise(rawCode);
  if (!/^[A-Z0-9-]{4,40}$/.test(code)) throw invalidCode();
  const settings = config ?? (await getRewardConfig());
  if (!ruleOn(settings, settings.referral))
    throw invalidCode("Referrals are paused right now. You can still sign up without a code.");
  const referrer = await User.findOne({ referralCode: code }).select("_id name role status phone");
  if (!referrer || referrer.role !== ROLES.CUSTOMER || referrer.status !== USER_STATUS.ACTIVE)
    throw invalidCode();
  const used = await Referral.countDocuments({ referrer: referrer._id });
  if (used >= settings.referral.maxReferralsPerCustomer)
    throw invalidCode("This referral code can no longer be used");
  return { referrer, code };
}

/** Public check for the sign-up form: only says whether a code works (never whose it is). */
export async function validateCode(rawCode) {
  try {
    await resolveCode(rawCode);
    return { valid: true };
  } catch (error) {
    if (error.code === "REFERRAL_INVALID") return { valid: false, message: error.message };
    throw error;
  }
}

/** A customer signed up with a code that resolveCode accepted. Records the relationship once. */
export async function recordSignup(user, { referrer, code }, { ip, now = new Date() } = {}) {
  if (String(referrer._id) === String(user._id)) throw invalidCode("You cannot use your own code");
  const config = await getRewardConfig();
  try {
    const [referral] = await Referral.create([
      {
        referrer: referrer._id,
        referred: user._id,
        code,
        status: R.REGISTERED,
        attributionExpiresAt: new Date(now.getTime() + config.referral.attributionDays * DAY_MS),
        signupIp: ip ? String(ip).slice(0, 64) : undefined,
        history: [{ status: R.REGISTERED, at: now }],
      },
    ]);
    return referral;
  } catch (error) {
    if (error?.code === 11000) return Referral.findOne({ referred: user._id }); // one referrer only
    throw error;
  }
}

const historyEntry = (status, note, at = new Date()) => ({ status, at, note });

// ---------------------------------------------------------------------------
// Order events
// ---------------------------------------------------------------------------

/** The referred friend placed an order: it becomes their candidate first order. */
export async function onOrderPlaced(order, now = new Date()) {
  await Referral.updateOne(
    { referred: order.customer, status: R.REGISTERED, attributionExpiresAt: { $gt: now } },
    {
      $set: { status: R.FIRST_ORDER_PLACED, qualifyingOrder: order._id },
      $push: { history: historyEntry(R.FIRST_ORDER_PLACED, `Order ${order.orderNumber}`, now) },
    },
  );
}

/** That order was cancelled or rejected: wait for another one (or expire). */
export async function onOrderClosed(order, now = new Date()) {
  const referral = await Referral.findOne({
    referred: order.customer,
    status: R.FIRST_ORDER_PLACED,
    qualifyingOrder: order._id,
  });
  if (!referral) return;
  const expired = referral.attributionExpiresAt <= now;
  const to = expired ? R.EXPIRED : R.REGISTERED;
  await Referral.updateOne(
    { _id: referral._id, status: R.FIRST_ORDER_PLACED, qualifyingOrder: order._id },
    {
      $set: { status: to, qualifyingOrder: null },
      $push: { history: historyEntry(to, `Order ${order.orderNumber} was ${order.status}`, now) },
    },
  );
}

/** Signals worth a human look. Uses only server data. */
async function riskFlags(referral, order) {
  const point = order.deliveryAddress?.location?.coordinates;
  const near = (o) => o && point && haversineMeters(point, o) <= SAME_PLACE_METERS;
  const nearOrder = (o) => near(o.deliveryAddress?.location?.coordinates);

  // Every lookup is independent; only the sibling orders wait for the sibling referrals.
  const [sameIp, addresses, referrerOrders, siblingOrders, burst] = await Promise.all([
    referral.signupIp ? Session.exists({ user: referral.referrer, ip: referral.signupIp }) : null,
    Address.find({ user: referral.referrer }).select("location").lean(),
    Order.find({ customer: referral.referrer, status: ORDER_STATUS.DELIVERED })
      .sort({ createdAt: -1 })
      .limit(20)
      .select("deliveryAddress.location")
      .lean(),
    Referral.find({ referrer: referral.referrer, _id: { $ne: referral._id }, qualifyingOrder: { $ne: null } })
      .select("qualifyingOrder")
      .limit(50)
      .lean()
      .then((siblings) =>
        siblings.length
          ? Order.find({ _id: { $in: siblings.map((r) => r.qualifyingOrder) } })
              .select("deliveryAddress.location")
              .lean()
          : [],
      ),
    Referral.countDocuments({
      referrer: referral.referrer,
      createdAt: { $gte: new Date(referral.createdAt.getTime() - DAY_MS), $lte: referral.createdAt },
    }),
  ]);
  return [
    sameIp && REFERRAL_RISK.SAME_SIGNUP_IP,
    (addresses.some((a) => near(a.location?.coordinates)) || referrerOrders.some(nearOrder)) &&
      REFERRAL_RISK.ADDRESS_MATCHES_REFERRER,
    siblingOrders.some(nearOrder) && REFERRAL_RISK.ADDRESS_SHARED_WITH_OTHER_REFERRAL,
    burst > VELOCITY_PER_DAY && REFERRAL_RISK.REFERRER_VELOCITY,
  ].filter(Boolean);
}

/** The friend's order was delivered: qualify the referral and reward it (or hold it). */
export async function onOrderDelivered(order, now = new Date()) {
  const referral = await Referral.findOne({
    referred: order.customer,
    status: { $in: [R.REGISTERED, R.FIRST_ORDER_PLACED] },
  });
  if (!referral) return null;
  const config = await getRewardConfig();
  if (!ruleOn(config, config.referral)) return null;

  // Ordered after the window closed: too late.
  if (order.createdAt > referral.attributionExpiresAt) {
    await Referral.updateOne(
      { _id: referral._id, status: referral.status },
      {
        $set: { status: R.EXPIRED, qualifyingOrder: null },
        $push: { history: historyEntry(R.EXPIRED, "First order came after the referral window", now) },
      },
    );
    return null;
  }
  if (foodValuePaise(order.pricing) < config.referral.minOrderPaise) {
    // Too small to qualify: keep waiting for a bigger first order.
    if (referral.status === R.FIRST_ORDER_PLACED && String(referral.qualifyingOrder) === String(order._id))
      await Referral.updateOne(
        { _id: referral._id, status: R.FIRST_ORDER_PLACED },
        {
          $set: { status: R.REGISTERED, qualifyingOrder: null },
          $push: { history: historyEntry(R.REGISTERED, `Order ${order.orderNumber} was below the minimum`, now) },
        },
      );
    return null;
  }

  // Exactly one delivered order qualifies.
  const qualified = await Referral.findOneAndUpdate(
    { _id: referral._id, status: { $in: [R.REGISTERED, R.FIRST_ORDER_PLACED] } },
    {
      $set: { status: R.ORDER_DELIVERED, qualifyingOrder: order._id, rewardStatus: RS.CREDITING },
      $push: { history: historyEntry(R.ORDER_DELIVERED, `Order ${order.orderNumber} delivered`, now) },
    },
    { returnDocument: "after", projection: "+signupIp" },
  );
  if (!qualified) return null;

  const flags = await riskFlags(qualified, order);
  if (flags.length) {
    await Referral.updateOne(
      { _id: qualified._id, rewardStatus: RS.CREDITING },
      { $set: { rewardStatus: RS.HELD, riskFlags: flags } },
    );
    logger.warn({ referralId: qualified.id, flags }, "Referral held for review");
    await notifyAdmins(
      {
        type: "referral.held",
        title: "A referral needs review",
        body: `Code ${qualified.code}: ${flags.length} risk signal(s)`,
        link: "/admin/rewards/referrals",
      },
      PERMISSIONS.REWARDS_MANAGE,
    );
    return Referral.findById(qualified._id);
  }
  return creditReferral(qualified._id, { now });
}

/** Claims one of the referrer's monthly reward slots. False when the month's limit is reached. */
async function claimReferrerSlot(referral, config, now) {
  if (referral.referrerSlot) return true; // claimed by an earlier attempt
  const period = localMonth(now, config.timezone);
  try {
    await ReferralRewardCounter.findOneAndUpdate(
      {
        referrer: referral.referrer,
        period,
        count: { $lt: config.referral.maxRewardsPerMonth },
      },
      { $inc: { count: 1 } },
      { upsert: true },
    );
  } catch (error) {
    if (error?.code === 11000) return false; // the counter exists and is full
    throw error;
  }
  await Referral.updateOne({ _id: referral._id }, { $set: { referrerSlot: period } });
  return true;
}

/**
 * Pays a qualified referral: the friend and (within the monthly limit) the referrer. Idempotent:
 * ledger keys per side, the referrer's monthly slot is remembered on the referral.
 */
export async function creditReferral(referralId, { now = new Date() } = {}) {
  const referral = await Referral.findById(referralId);
  if (!referral || referral.status !== R.ORDER_DELIVERED) return referral;
  if (![RS.CREDITING].includes(referral.rewardStatus)) return referral;
  const config = await getRewardConfig();
  const { referrerCoins, referredCoins } = config.referral;
  const [friend, inviter] = await Promise.all([
    User.findById(referral.referred).select("name"),
    User.findById(referral.referrer).select("name status"),
  ]);

  let paidReferred = 0;
  if (referredCoins > 0) {
    const { txn } = await wallet.credit(referral.referred, {
      coins: referredCoins,
      source: COIN_SOURCES.REFERRAL_REWARD,
      key: referralRewardKey(referral._id, "referred"),
      referral: referral._id,
      order: referral.qualifyingOrder,
      description: "Referral bonus for your first order",
    });
    paidReferred = txn.coins;
  }
  let paidReferrer = 0;
  const inviterActive = inviter?.status === USER_STATUS.ACTIVE;
  if (referrerCoins > 0 && inviterActive && (await claimReferrerSlot(referral, config, now))) {
    const { txn } = await wallet.credit(referral.referrer, {
      coins: referrerCoins,
      source: COIN_SOURCES.REFERRAL_REWARD,
      key: referralRewardKey(referral._id, "referrer"),
      referral: referral._id,
      description: `${friend?.name?.split(" ")[0] ?? "Your friend"} joined with your code`,
    });
    paidReferrer = txn.coins;
  }

  const partial = referrerCoins > 0 && paidReferrer === 0;
  const updated = await Referral.findOneAndUpdate(
    { _id: referral._id, rewardStatus: RS.CREDITING },
    {
      $set: {
        status: R.REWARD_CREDITED,
        rewardStatus: partial ? RS.PARTIAL : RS.CREDITED,
        referrerCoins: paidReferrer,
        referredCoins: paidReferred,
        rewardedAt: now,
      },
      $push: {
        history: historyEntry(
          R.REWARD_CREDITED,
          partial ? "Friend rewarded; referrer limit reached" : "Both rewarded",
          now,
        ),
      },
    },
    { returnDocument: "after" },
  );
  if (updated) {
    await Promise.all([
      paidReferred &&
        notify(referral.referred, {
          type: "coins.referral",
          title: `You earned ${paidReferred} referral coins`,
          body: "Thanks for ordering with BiteBox",
          link: "/account/coins",
        }),
      paidReferrer &&
        notify(referral.referrer, {
          type: "coins.referral",
          title: `You earned ${paidReferrer} coins`,
          body: `${friend?.name?.split(" ")[0] ?? "Your friend"} completed their first order`,
          link: "/account/refer",
        }),
    ]);
  }
  return updated ?? Referral.findById(referral._id);
}

/** Rewards sweep: expire unused referrals and finish rewards a crash left half-paid. */
export async function referralSweep({ now = new Date(), limit = 200 } = {}) {
  const expired = await Referral.updateMany(
    { status: R.REGISTERED, attributionExpiresAt: { $lte: now } },
    {
      $set: { status: R.EXPIRED },
      $push: { history: historyEntry(R.EXPIRED, "No qualifying order in time", now) },
    },
  );
  const stuck = await Referral.find({
    status: R.ORDER_DELIVERED,
    rewardStatus: RS.CREDITING,
    updatedAt: { $lte: new Date(now.getTime() - 5 * 60_000) },
  })
    .select("_id")
    .limit(limit);
  let finished = 0;
  for (const r of stuck) {
    try {
      await creditReferral(r._id, { now });
      finished++;
    } catch (err) {
      logger.error({ err, referralId: String(r._id) }, "Could not finish a referral reward");
    }
  }
  return { expired: expired.modifiedCount, finished };
}

// ---------------------------------------------------------------------------
// Customer views
// ---------------------------------------------------------------------------

/** "Riya S." Friends are never shown with full names, emails or phones. */
const maskName = (name) => {
  const [first = "Friend", ...rest] = String(name ?? "").trim().split(/\s+/);
  const last = rest.at(-1);
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
};

const CUSTOMER_STATUS = (r) =>
  // Held and rejected referrals look the same to customers: "not eligible" without reasons.
  r.status === R.REJECTED ? "NOT_ELIGIBLE" : r.status;

function referralRules(config) {
  const r = config.referral;
  return {
    enabled: ruleOn(config, r),
    referrerCoins: r.referrerCoins,
    referredCoins: r.referredCoins,
    minOrderPaise: r.minOrderPaise,
    attributionDays: r.attributionDays,
    maxReferrals: r.maxReferralsPerCustomer,
  };
}

export async function myReferral(userId) {
  const [code, config] = await Promise.all([ensureReferralCode(userId), getRewardConfig()]);
  const [counts, mine] = await Promise.all([
    Referral.aggregate([
      { $match: { referrer: userId } },
      {
        $group: {
          _id: "$status",
          n: { $sum: 1 },
          coins: { $sum: "$referrerCoins" },
        },
      },
    ]),
    Referral.findOne({ referred: userId }).lean(),
  ]);
  const by = Object.fromEntries(counts.map((c) => [c._id, c]));
  const n = (...statuses) => statuses.reduce((sum, s) => sum + (by[s]?.n ?? 0), 0);
  const invited = n(...Object.values(R));
  return {
    code,
    link: referralLink(code),
    rules: referralRules(config),
    stats: {
      invited,
      pending: n(R.REGISTERED, R.FIRST_ORDER_PLACED, R.ORDER_DELIVERED),
      successful: n(R.REWARD_CREDITED),
      unsuccessful: n(R.EXPIRED, R.REJECTED),
      coinsEarned: counts.reduce((sum, c) => sum + c.coins, 0),
      remaining: Math.max(0, config.referral.maxReferralsPerCustomer - invited),
    },
    referredBy: mine
      ? {
          status: CUSTOMER_STATUS(mine),
          coins: mine.referredCoins,
          expiresAt: mine.attributionExpiresAt,
        }
      : null,
  };
}

export async function myReferralHistory(userId, { status } = {}, pagination) {
  const filter = { referrer: userId };
  if (status) filter.status = status === "NOT_ELIGIBLE" ? R.REJECTED : status;
  const [items, total] = await Promise.all([
    Referral.find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .populate("referred", "name")
      .lean(),
    Referral.countDocuments(filter),
  ]);
  return {
    items: items.map((r) => ({
      id: String(r._id),
      friend: maskName(r.referred?.name),
      status: CUSTOMER_STATUS(r),
      coins: r.referrerCoins,
      joinedAt: r.createdAt,
      expiresAt: r.attributionExpiresAt,
      rewardedAt: r.rewardedAt,
    })),
    pagination: paginationMeta(pagination, total),
  };
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export async function adminList({ status, rewardStatus, flagged, search }, pagination) {
  const filter = {};
  if (status) filter.status = status;
  if (rewardStatus) filter.rewardStatus = rewardStatus;
  if (flagged) filter["riskFlags.0"] = { $exists: true };
  if (search) {
    const ids = await matchingUserIds(search, ["referralCode"]);
    filter.$or = [
      { referrer: { $in: ids } },
      { referred: { $in: ids } },
      { code: new RegExp(escapeRegex(search), "i") },
    ];
  }
  const [items, total, statusCounts] = await Promise.all([
    Referral.find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .populate("referrer", "name email")
      .populate("referred", "name email")
      .populate("qualifyingOrder", "orderNumber status"),
    Referral.countDocuments(filter),
    Referral.aggregate([{ $group: { _id: "$rewardStatus", n: { $sum: 1 } } }]),
  ]);
  return {
    items: items.map(adminView),
    pagination: paginationMeta(pagination, total),
    counts: Object.fromEntries(statusCounts.map((c) => [c._id, c.n])),
  };
}

function adminView(r) {
  const json = r.toJSON();
  return {
    ...json,
    referrer: personView(r.referrer),
    referred: personView(r.referred),
    qualifyingOrder: r.qualifyingOrder?.orderNumber
      ? { id: String(r.qualifyingOrder._id), orderNumber: r.qualifyingOrder.orderNumber, status: r.qualifyingOrder.status }
      : json.qualifyingOrder,
  };
}

export async function adminGet(id) {
  const referral = await Referral.findById(id)
    .populate("referrer", "name email")
    .populate("referred", "name email")
    .populate("qualifyingOrder", "orderNumber status");
  if (!referral) throw ApiError.notFound("Referral not found");
  return adminView(referral);
}

/** An admin approves a held referral: it is paid like any other. */
export async function approve(admin, id, note) {
  const held = await Referral.findOneAndUpdate(
    { _id: id, status: R.ORDER_DELIVERED, rewardStatus: RS.HELD },
    { $set: { rewardStatus: RS.CREDITING, decision: { by: admin._id, note, at: new Date() } } },
    { returnDocument: "after" },
  );
  if (!held) throw new ApiError(409, "Only referrals held for review can be approved", { code: "NOT_HELD" });
  await creditReferral(held._id);
  return adminGet(id);
}

/** An admin rejects a referral that has not been paid. */
export async function reject(admin, id, note) {
  const now = new Date();
  const updated = await Referral.findOneAndUpdate(
    {
      _id: id,
      status: { $in: [R.REGISTERED, R.FIRST_ORDER_PLACED, R.ORDER_DELIVERED] },
      rewardStatus: { $in: [RS.NONE, RS.HELD] },
    },
    {
      $set: { status: R.REJECTED, rewardStatus: RS.REJECTED, decision: { by: admin._id, note, at: now } },
      $push: { history: historyEntry(R.REJECTED, "Rejected after review", now) },
    },
  );
  if (!updated)
    throw new ApiError(409, "This referral can no longer be rejected", { code: "NOT_REJECTABLE" });
  return adminGet(id);
}

/** Totals for the admin dashboard. */
export async function stats() {
  const [byStatus, coins] = await Promise.all([
    Referral.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    Referral.aggregate([
      {
        $group: {
          _id: null,
          referrerCoins: { $sum: "$referrerCoins" },
          referredCoins: { $sum: "$referredCoins" },
          held: { $sum: { $cond: [{ $eq: ["$rewardStatus", RS.HELD] }, 1, 0] } },
          flagged: { $sum: { $cond: [{ $gt: [{ $size: "$riskFlags" }, 0] }, 1, 0] } },
        },
      },
    ]),
  ]);
  return {
    byStatus: Object.fromEntries(byStatus.map((s) => [s._id, s.n])),
    total: byStatus.reduce((sum, s) => sum + s.n, 0),
    coinsPaid: (coins[0]?.referrerCoins ?? 0) + (coins[0]?.referredCoins ?? 0),
    held: coins[0]?.held ?? 0,
    flagged: coins[0]?.flagged ?? 0,
  };
}
