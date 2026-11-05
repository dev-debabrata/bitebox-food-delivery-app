import { COIN_SOURCES, COIN_TXN_TYPES, REVERSAL_OF } from "../config/rewards.js";
import { CoinTransaction, LEDGER_STATUS } from "../models/coin-transaction.model.js";
import { CoinWallet } from "../models/coin-wallet.model.js";
import { CAMPAIGN_STATUS, RewardCampaign } from "../models/reward-campaign.model.js";
import { User } from "../models/user.model.js";
import { ApiError } from "../utils/api-error.js";
import { paginationMeta } from "../utils/pagination.js";
import { matchingUserIds, personView } from "../utils/people.js";
import * as wallet from "./coin-wallet.service.js";
import * as referrals from "./referral.service.js";
import { coinsToPaise, getRewardConfig } from "./reward-config.service.js";
import { day, fillDays, since } from "./reports.service.js";

/** Super admin views over the coin ledger: transactions, wallets, reversals and reports. */

const T = COIN_TXN_TYPES;
const S = COIN_SOURCES;
const posted = { status: LEDGER_STATUS.POSTED };

const person = personView;

/** A ledger row with everything staff may see. */
function staffTxnView(row) {
  return {
    ...wallet.customerTxnView(row),
    seq: row.seq,
    status: row.status,
    reversalOf: row.reversalOf ?? null,
    requestedCoins: row.requestedCoins ?? null,
    shortfall: row.shortfall ?? null,
    availableBefore: row.availableBefore,
    availableAfter: row.availableAfter,
    reservedBefore: row.reservedBefore,
    reservedAfter: row.reservedAfter,
    idempotencyKey: row.idempotencyKey,
    campaignId: row.campaign ? String(row.campaign._id ?? row.campaign) : null,
    referralId: row.referral ? String(row.referral) : null,
    relatedTxnId: row.relatedTxn ? String(row.relatedTxn) : null,
    note: row.note ?? null,
    createdBy: row.createdBy?.name ? person(row.createdBy) : row.createdBy ? { id: String(row.createdBy) } : null,
    customer: person(row.user),
    allocations: (row.allocations ?? []).map((a) => ({
      source: a.source,
      coins: a.coins,
      earnedAt: a.earnedAt,
      expiresAt: a.expiresAt ?? null,
    })),
  };
}

export async function listTransactions({ type, source, search, userId, from, to }, pagination) {
  const filter = { ...posted };
  if (type) filter.type = type;
  if (source) filter.source = source;
  if (userId) filter.user = userId;
  if (from || to) filter.createdAt = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  if (search) {
    filter.user = { $in: await matchingUserIds(search) };
  }
  const [rows, total] = await Promise.all([
    CoinTransaction.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .populate("user", "name email")
      .lean(),
    CoinTransaction.countDocuments(filter),
  ]);
  return { items: rows.map(staffTxnView), pagination: paginationMeta(pagination, total) };
}

export async function getTransaction(id) {
  const row = await CoinTransaction.findById(id)
    .populate("user", "name email")
    .populate("createdBy", "name email")
    .populate("campaign", "name")
    .lean();
  if (!row) throw ApiError.notFound("Transaction not found");
  const related = await CoinTransaction.find({ relatedTxn: row._id }).sort({ seq: 1 }).lean();
  return {
    transaction: { ...staffTxnView(row), campaign: row.campaign?.name ? { id: String(row.campaign._id), name: row.campaign.name } : null },
    related: related.map(staffTxnView),
  };
}

/**
 * Staff claw back coins from an earned reward (refund, fraud). Partial amounts add up to at most the
 * reward; already-spent coins become a shortfall, never a negative balance. `requestKey` makes the
 * request idempotent (the Idempotency-Key header).
 */
export async function reverseTransaction(admin, id, { coins, reason }, requestKey) {
  const row = await CoinTransaction.findById(id).lean();
  if (!row) throw ApiError.notFound("Transaction not found");
  if (row.type !== T.CREDIT)
    throw new ApiError(409, "Only earned rewards can be reversed", { code: "NOT_REVERSIBLE" });
  const { txn } = await wallet.reverseCredit(row.user, {
    creditKey: row.idempotencyKey,
    coins,
    key: `admin-reversal:${row._id}:${requestKey}`,
    description: "Reward reversed by BiteBox",
    note: reason,
    createdBy: admin._id,
  });
  return getTransaction(txn._id);
}

/** One customer's wallet, its batches, the ledger check, and recent history. */
export async function walletDetail(userId) {
  const user = await User.findById(userId).select("name email role status referralCode").lean();
  if (!user) throw ApiError.notFound("Customer not found");
  const [summary, raw, check, recent] = await Promise.all([
    wallet.walletSummary(userId),
    CoinWallet.findOne({ user: userId }).lean(),
    wallet.reconcile(userId),
    CoinTransaction.find({ user: userId, ...posted }).sort({ seq: -1 }).limit(20).lean(),
  ]);
  return {
    customer: { ...person({ ...user, _id: user._id }), role: user.role, status: user.status, referralCode: user.referralCode ?? null },
    wallet: { ...summary, uncollectedReversal: raw?.uncollectedReversal ?? 0, seq: raw?.seq ?? 0 },
    batches: (raw?.batches ?? []).map((b) => ({
      source: b.source,
      original: b.original,
      remaining: b.remaining,
      earnedAt: b.earnedAt,
      expiresAt: b.expiresAt ?? null,
    })),
    integrity: check,
    recent: recent.map(staffTxnView),
  };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const sumWhen = (condition) => ({ $sum: { $cond: [condition, "$coins", 0] } });
const isType = (t) => ({ $eq: ["$type", t] });
const and = (...c) => ({ $and: c });
const isSource = (...s) => ({ $in: ["$source", s] });
const reversalOf = (r) => ({ $eq: ["$reversalOf", r] });

const TOTALS = {
  issued: sumWhen(isType(T.CREDIT)),
  redeemed: sumWhen(isType(T.DEBIT)),
  refundedRedemptions: sumWhen(and(isType(T.REVERSAL), reversalOf(REVERSAL_OF.REDEMPTION))),
  expired: sumWhen(isType(T.EXPIRE)),
  reversed: sumWhen(and(isType(T.REVERSAL), reversalOf(REVERSAL_OF.CREDIT))),
  orderRewards: sumWhen(and(isType(T.CREDIT), isSource(S.ORDER_REWARD))),
  reviewRewards: sumWhen(and(isType(T.CREDIT), isSource(S.REVIEW_REWARD))),
  referralRewards: sumWhen(and(isType(T.CREDIT), isSource(S.REFERRAL_REWARD))),
  welcomeRewards: sumWhen(and(isType(T.CREDIT), isSource(S.WELCOME_REWARD))),
  birthdayRewards: sumWhen(and(isType(T.CREDIT), isSource(S.BIRTHDAY_REWARD))),
  promotionalRewards: sumWhen(and(isType(T.CREDIT), isSource(S.FESTIVAL_REWARD, S.PROMOTIONAL_REWARD))),
};

export async function reports(days = 30) {
  const from = since(days);
  const [config, allTime, period, daily, liability, campaigns, activeCampaigns, referralStats, shortfalls, topEarners] =
    await Promise.all([
      getRewardConfig(),
      CoinTransaction.aggregate([{ $match: posted }, { $group: { _id: null, ...TOTALS } }]),
      CoinTransaction.aggregate([
        { $match: { ...posted, createdAt: { $gte: from } } },
        { $group: { _id: null, ...TOTALS } },
      ]),
      CoinTransaction.aggregate([
        { $match: { ...posted, createdAt: { $gte: from } } },
        {
          $group: {
            _id: day("$createdAt"),
            issued: TOTALS.issued,
            redeemed: TOTALS.redeemed,
            expired: TOTALS.expired,
          },
        },
      ]),
      CoinWallet.aggregate([
        {
          $group: {
            _id: null,
            available: { $sum: "$available" },
            reserved: { $sum: "$reserved" },
            wallets: { $sum: 1 },
            activeWallets: { $sum: { $cond: [{ $gt: [{ $add: ["$available", "$reserved"] }, 0] }, 1, 0] } },
          },
        },
      ]),
      RewardCampaign.find({ "stats.claims": { $gt: 0 } })
        .sort({ "stats.coins": -1 })
        .limit(10)
        .select("name type status stats rewardCoins startAt endAt")
        .lean(),
      RewardCampaign.countDocuments({ status: CAMPAIGN_STATUS.ACTIVE }),
      referrals.stats(),
      CoinWallet.aggregate([
        { $match: { uncollectedReversal: { $gt: 0 } } },
        { $group: { _id: null, wallets: { $sum: 1 }, coins: { $sum: "$uncollectedReversal" } } },
      ]),
      // Unusually fast earners over the last week (excludes order rewards, which track real spend).
      CoinTransaction.aggregate([
        {
          $match: {
            ...posted,
            type: T.CREDIT,
            source: { $ne: S.ORDER_REWARD },
            createdAt: { $gte: since(7) },
          },
        },
        { $group: { _id: "$user", coins: { $sum: "$coins" }, credits: { $sum: 1 } } },
        { $sort: { coins: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: "users",
            localField: "_id",
            foreignField: "_id",
            pipeline: [{ $project: { name: 1, email: 1 } }],
            as: "user",
          },
        },
      ]),
    ]);
  const zero = Object.fromEntries(Object.keys(TOTALS).map((k) => [k, 0]));
  const clean = (row) => {
    const { _id, ...rest } = row ?? {};
    void _id;
    return { ...zero, ...rest, netRedeemed: (rest.redeemed ?? 0) - (rest.refundedRedemptions ?? 0) };
  };
  const owed = liability[0] ?? { available: 0, reserved: 0, wallets: 0, activeWallets: 0 };
  const outstanding = owed.available + owed.reserved;
  return {
    days,
    allTime: clean(allTime[0]),
    period: clean(period[0]),
    daily: fillDays(days, daily, { issued: 0, redeemed: 0, expired: 0 }),
    liability: {
      coins: outstanding,
      paise: coinsToPaise(outstanding, config),
      availableCoins: owed.available,
      reservedCoins: owed.reserved,
    },
    wallets: { total: owed.wallets, active: owed.activeWallets },
    campaigns: {
      active: activeCampaigns,
      top: campaigns.map((c) => ({
        id: String(c._id),
        name: c.name,
        type: c.type,
        status: c.status,
        claims: c.stats.claims,
        coins: c.stats.coins,
      })),
    },
    referrals: referralStats,
    suspicious: {
      heldReferrals: referralStats.held,
      flaggedReferrals: referralStats.flagged,
      uncollectedReversals: { wallets: shortfalls[0]?.wallets ?? 0, coins: shortfalls[0]?.coins ?? 0 },
      topEarners: topEarners.map((e) => ({
        customer: person(e.user[0]),
        coins: e.coins,
        credits: e.credits,
      })),
    },
  };
}
