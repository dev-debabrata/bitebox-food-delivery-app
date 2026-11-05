import mongoose from "mongoose";
import { logger } from "../config/logger.js";
import {
  COIN_LIMITS,
  COIN_SOURCES,
  COIN_TXN_TYPES,
  EARN_SOURCES,
  LEDGER,
  REVERSAL_OF,
} from "../config/rewards.js";
import { CoinTransaction, LEDGER_STATUS } from "../models/coin-transaction.model.js";
import { CoinWallet } from "../models/coin-wallet.model.js";
import { ApiError } from "../utils/api-error.js";
import { DAY_MS, localDay } from "../utils/dates.js";
import { paginationMeta } from "../utils/pagination.js";
import {
  coinsToPaise,
  expiryFor,
  getRewardConfig,
  restoredExpiry,
} from "./reward-config.service.js";

/**
 * The coin wallet and its ledger. Every change to a wallet is one immutable CoinTransaction row;
 * the wallet document holds the running totals and the live credit batches.
 *
 * Concurrency (works with or without MongoDB transactions):
 *   1. Read the wallet at seq n and plan the row (balance checks, FIFO allocations).
 *   2. Insert the row with seq n+1. The unique (wallet, seq) index lets only one writer claim
 *      n+1; a loser finishes the winner's row and plans again. A repeated idempotency key
 *      returns the existing row.
 *   3. Move the wallet from seq n to n+1 (conditional update), then mark the row posted.
 * A crash between 2 and 3 leaves a pending row; the next operation on that wallet (or the
 * rewards sweep) applies it. Applying is deterministic: applyTxn(wallet at n, row).
 * With a session (inside withTransaction) the same steps run in the transaction.
 *
 * Only this module writes wallets. Callers check whether coins are enabled; the ledger itself
 * always works, so staff can still correct balances when the programme is switched off.
 */

const T = COIN_TXN_TYPES;
const S = COIN_SOURCES;
const { ObjectId } = mongoose.Types;

const STATE_FIELDS = [
  "available",
  "reserved",
  "totalEarned",
  "totalRedeemed",
  "totalExpired",
  "totalReversed",
  "uncollectedReversal",
  "seq",
  "batches",
];
const COUNTERS = STATE_FIELDS.filter((f) => f !== "batches");

const conflict = (message, code) => ApiError.conflict(message, code);
const sameId = (a, b) => String(a) === String(b);
const sum = (items, pick) => items.reduce((n, item) => n + pick(item), 0);

function assertCoins(coins, { min = 1 } = {}) {
  if (
    !Number.isInteger(coins) ||
    coins < min ||
    coins > COIN_LIMITS.maxCoinsPerOperation
  ) {
    throw new ApiError(422, "Coins must be a positive whole number", {
      code: "VALIDATION_ERROR",
      details: [{ field: "coins", message: "Coins must be a positive whole number" }],
    });
  }
}

// ---------------------------------------------------------------------------
// Pure wallet arithmetic
// ---------------------------------------------------------------------------

const emptyState = () => ({
  ...Object.fromEntries(COUNTERS.map((f) => [f, 0])),
  batches: [],
});

function toState(wallet) {
  const state = emptyState();
  for (const f of COUNTERS) state[f] = wallet?.[f] ?? 0;
  state.batches = (wallet?.batches ?? []).map((b) => ({
    _id: b._id,
    origin: b.origin,
    source: b.source,
    original: b.original,
    remaining: b.remaining,
    earnedAt: b.earnedAt,
    expiresAt: b.expiresAt ?? null,
  }));
  return state;
}

const toSet = (state) => Object.fromEntries(STATE_FIELDS.map((f) => [f, state[f]]));

const isOverdue = (batch, now) => Boolean(batch.expiresAt && batch.expiresAt <= now);

/** Earliest expiry first (never-expiring last), then oldest first. */
function fifo(a, b) {
  const ea = a.expiresAt ? a.expiresAt.getTime() : Infinity;
  const eb = b.expiresAt ? b.expiresAt.getTime() : Infinity;
  if (ea !== eb) return ea - eb;
  const da = a.earnedAt.getTime() - b.earnedAt.getTime();
  if (da !== 0) return da;
  return String(a._id).localeCompare(String(b._id));
}

const allocationFrom = (batch, coins) => ({
  batch: batch._id,
  origin: batch.origin,
  source: batch.source,
  earnedAt: batch.earnedAt,
  expiresAt: batch.expiresAt ?? null,
  coins,
});

/**
 * Takes up to `coins` from the batches, FIFO. `includeOverdue: false` skips coins past their
 * expiry date that the sweep has not removed yet. `preferOrigin` drains that credit's batches first.
 */
function takeFifo(batches, coins, { now = new Date(), includeOverdue = false, preferOrigin } = {}) {
  const candidates = batches
    .filter((b) => b.remaining > 0 && (includeOverdue || !isOverdue(b, now)))
    .sort((a, b) => {
      if (preferOrigin) {
        const pa = sameId(a.origin, preferOrigin) ? 0 : 1;
        const pb = sameId(b.origin, preferOrigin) ? 0 : 1;
        if (pa !== pb) return pa - pb;
      }
      return fifo(a, b);
    });
  const allocations = [];
  let left = coins;
  for (const batch of candidates) {
    if (left === 0) break;
    const take = Math.min(batch.remaining, left);
    allocations.push(allocationFrom(batch, take));
    left -= take;
  }
  return { allocations, taken: coins - left };
}

/** Coins that can be spent right now (excludes coins past expiry when expiry is on). */
function spendable(state, { now = new Date(), expiryEnabled = true } = {}) {
  return sum(
    state.batches.filter((b) => !expiryEnabled || !isOverdue(b, now)),
    (b) => b.remaining,
  );
}

/** Coins handed back from a reservation go to new batches keeping their origin and (graced) expiry. */
function restoreAllocations(allocations, config, now) {
  return allocations.map((a) => ({
    batch: new ObjectId(),
    origin: a.origin,
    source: a.source,
    earnedAt: a.earnedAt,
    expiresAt: config.expiry.enabled
      ? restoredExpiry(a.expiresAt ?? null, config, now)
      : (a.expiresAt ?? null),
    coins: a.coins,
  }));
}

/**
 * The wallet after one ledger row. Pure and deterministic: the same (state, row) always gives the
 * same result, which is what makes crash recovery safe. Throws if the row does not fit.
 */
function applyTxn(state, row) {
  const next = { ...state, batches: state.batches.map((b) => ({ ...b })) };
  const c = row.coins;
  const allocations = row.allocations ?? [];

  const consume = () => {
    for (const a of allocations) {
      const batch = next.batches.find((b) => sameId(b._id, a.batch));
      if (!batch || batch.remaining < a.coins)
        throw new Error(`Ledger row ${row._id}: batch ${a.batch} cannot cover ${a.coins} coins`);
      batch.remaining -= a.coins;
    }
    next.batches = next.batches.filter((b) => b.remaining > 0);
  };
  const restore = () => {
    for (const a of allocations)
      next.batches.push({
        _id: a.batch,
        origin: a.origin,
        source: a.source,
        original: a.coins,
        remaining: a.coins,
        earnedAt: a.earnedAt,
        expiresAt: a.expiresAt ?? null,
      });
  };
  const allocated = sum(allocations, (a) => a.coins);

  switch (row.type) {
    case T.CREDIT:
      next.available += c;
      next.totalEarned += c;
      next.batches.push({
        _id: row._id,
        origin: row._id,
        source: row.source,
        original: c,
        remaining: c,
        earnedAt: row.createdAt,
        expiresAt: row.expiresAt ?? null,
      });
      break;
    case T.RESERVE:
      consume();
      next.available -= c;
      next.reserved += c;
      break;
    case T.DEBIT:
      next.reserved -= c;
      next.totalRedeemed += c;
      break;
    case T.RELEASE:
      restore();
      next.reserved -= c;
      next.available += c;
      break;
    case T.EXPIRE:
      consume();
      next.available -= c;
      next.totalExpired += c;
      break;
    case T.REVERSAL:
      if (row.reversalOf === REVERSAL_OF.CREDIT) {
        consume();
        next.available -= c;
        next.totalReversed += c;
        next.uncollectedReversal += row.shortfall ?? 0;
      } else {
        restore();
        next.available += c;
        next.totalRedeemed -= c;
      }
      break;
    default:
      throw new Error(`Unknown ledger row type ${row.type}`);
  }
  if (
    [T.RESERVE, T.RELEASE, T.EXPIRE, T.REVERSAL].includes(row.type) &&
    allocated !== c
  )
    throw new Error(`Ledger row ${row._id}: allocations (${allocated}) do not match ${c} coins`);
  if (COUNTERS.some((f) => f !== "seq" && next[f] < 0))
    throw new Error(`Ledger row ${row._id} would make the wallet negative`);
  if (next.available !== sum(next.batches, (b) => b.remaining))
    throw new Error(`Ledger row ${row._id} breaks available == sum(batches)`);
  next.seq = row.seq;
  return next;
}

// ---------------------------------------------------------------------------
// Ledger engine
// ---------------------------------------------------------------------------

async function loadWallet(userId, session) {
  const find = () => CoinWallet.findOne({ user: userId }).session(session).lean();
  const existing = await find();
  if (existing) return existing;
  try {
    await CoinWallet.create([{ user: userId }], { session });
  } catch (error) {
    if (error?.code !== 11000) throw error; // created concurrently
  }
  return find();
}

const markPosted = (rowId, now = new Date()) =>
  CoinTransaction.updateOne(
    { _id: rowId, status: LEDGER_STATUS.PENDING },
    { $set: { status: LEDGER_STATUS.POSTED, postedAt: now } },
  );

/** Applies any pending rows of a wallet, in order. Safe to run concurrently and repeatedly. */
async function settleWallet(walletId) {
  const rows = await CoinTransaction.find({
    wallet: walletId,
    status: LEDGER_STATUS.PENDING,
  }).sort({ seq: 1 });
  let wallet = await CoinWallet.findById(walletId).lean();
  for (const row of rows) {
    if (row.seq === wallet.seq + 1) {
      const next = applyTxn(toState(wallet), row.toObject());
      const { matchedCount } = await CoinWallet.updateOne(
        { _id: walletId, seq: wallet.seq },
        { $set: toSet(next) },
      );
      // No match: someone else moved the wallet (most likely applied this very row); re-read.
      wallet = matchedCount ? { ...wallet, ...next } : await CoinWallet.findById(walletId).lean();
    } else if (row.seq > wallet.seq + 1) {
      logger.error({ walletId: String(walletId), seq: row.seq }, "Ledger gap: pending row ahead of wallet");
      return;
    }
    if (wallet.seq >= row.seq) await markPosted(row._id);
  }
}

/** Rewards sweep: finishes rows left pending by a crash. */
export async function settlePendingRows({ now = new Date(), limit = 100 } = {}) {
  const wallets = await CoinTransaction.distinct("wallet", {
    status: LEDGER_STATUS.PENDING,
    createdAt: { $lte: new Date(now.getTime() - LEDGER.pendingRecoveryMs) },
  });
  for (const walletId of wallets.slice(0, limit)) await settleWallet(walletId);
  return wallets.length;
}

/** An error that makes withTransaction run the whole unit of work again on a fresh snapshot. */
function retryTransaction(message) {
  const error = new mongoose.mongo.MongoError(message);
  error.addErrorLabel("TransientTransactionError");
  return error;
}

const pause = (attempt) =>
  new Promise((resolve) => setTimeout(resolve, Math.random() * Math.min(40, 2 ** attempt)));

/**
 * Runs one wallet operation. `plan(state, ctx)` returns the row fields (type, source, coins,
 * allocations, references...), null for "nothing to do", or throws (e.g. not enough coins).
 * Returns { txn, created }; a repeated key returns the original row with created: false.
 */
async function execute(userId, key, plan, { session = null, now = new Date() } = {}) {
  if (!key || typeof key !== "string") throw new Error("A wallet operation needs an idempotency key");
  for (let attempt = 0; attempt < LEDGER.maxAttempts; attempt++) {
    const existing = await CoinTransaction.findOne({ idempotencyKey: key }).session(session);
    if (existing) {
      if (!sameId(existing.user, userId))
        throw new Error(`Idempotency key ${key} belongs to another wallet`);
      if (existing.status === LEDGER_STATUS.PENDING && !session) {
        await settleWallet(existing.wallet);
        return { txn: await CoinTransaction.findById(existing._id), created: false };
      }
      return { txn: existing, created: false };
    }

    const wallet = await loadWallet(userId, session);
    const state = toState(wallet);
    // An unfinished row (crash) must be applied before planning, or the plan would see a stale balance.
    if (await CoinTransaction.exists({ wallet: wallet._id, seq: state.seq + 1 }).session(session)) {
      await settleWallet(wallet._id);
      if (session) throw retryTransaction("Coin wallet had an unfinished operation");
      continue;
    }
    const fields = await plan(state, { now, session, walletId: wallet._id });
    if (!fields) return { txn: null, created: false };

    const row = {
      _id: new ObjectId(),
      ...fields,
      user: userId,
      wallet: wallet._id,
      seq: state.seq + 1,
      idempotencyKey: key,
      createdAt: now,
      status: session ? LEDGER_STATUS.POSTED : LEDGER_STATUS.PENDING,
      postedAt: session ? now : null,
    };
    const next = applyTxn(state, row);
    Object.assign(row, {
      availableBefore: state.available,
      availableAfter: next.available,
      reservedBefore: state.reserved,
      reservedAfter: next.reserved,
    });

    let txn;
    try {
      [txn] = await CoinTransaction.create([row], { session });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      // Lost a race inside a transaction: let withTransaction retry the whole unit of work.
      if (session) throw retryTransaction("Coin wallet changed by another operation");
      if (error.keyPattern?.seq) await settleWallet(wallet._id);
      await pause(attempt);
      continue; // a duplicate idempotency key is answered at the top of the loop
    }

    const result = await CoinWallet.updateOne(
      { _id: wallet._id, seq: state.seq },
      { $set: toSet(next) },
      { session },
    );
    if (result.matchedCount === 0 && session)
      throw new Error("Coin wallet changed inside a transaction");
    // Without a session, no match means a concurrent settleWallet already applied this very row.
    if (!session) {
      await markPosted(txn._id, now);
      txn.status = LEDGER_STATUS.POSTED;
      txn.postedAt = now;
    }
    return { txn, created: true };
  }
  throw conflict("Your coin wallet is busy. Please try again.", "WALLET_BUSY");
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Adds earned coins as a new batch. `expiresAt` defaults to the source's configured expiry
 * (pass null for coins that never expire).
 */
export async function credit(
  userId,
  { coins, source, key, description, order, campaign, referral, createdBy, note, expiresAt },
  options = {},
) {
  assertCoins(coins);
  if (!EARN_SOURCES.includes(source)) throw new Error(`${source} is not an earning source`);
  const now = options.now ?? new Date();
  const expiry =
    expiresAt !== undefined ? expiresAt : expiryFor(source, await getRewardConfig(), now);
  return execute(
    userId,
    key,
    () => ({
      type: T.CREDIT,
      source,
      coins,
      expiresAt: expiry,
      description: description ?? `${coins} coins earned`,
      order,
      campaign,
      referral,
      createdBy,
      note,
    }),
    { ...options, now },
  );
}

/** Holds coins for an order (checkout). Fails with INSUFFICIENT_COINS when they are not there. */
export async function reserve(userId, { coins, key, order, description }, options = {}) {
  assertCoins(coins);
  const config = await getRewardConfig();
  return execute(
    userId,
    key,
    (state, { now }) => {
      const { allocations, taken } = takeFifo(state.batches, coins, {
        now,
        includeOverdue: !config.expiry.enabled,
      });
      if (taken < coins) {
        throw conflict(
          `You have only ${spendable(state, { now, expiryEnabled: config.expiry.enabled })} coins available`,
          "INSUFFICIENT_COINS",
        );
      }
      return {
        type: T.RESERVE,
        source: S.COIN_REDEMPTION,
        coins,
        allocations,
        order,
        description: description ?? `${coins} coins held for your order`,
      };
    },
    options,
  );
}

async function findReservation(userId, reserveKey, session) {
  const reservation = await CoinTransaction.findOne({
    idempotencyKey: reserveKey,
    user: userId,
    type: T.RESERVE,
  }).session(session);
  if (!reservation) throw ApiError.notFound("Coin reservation not found");
  if (reservation.status === LEDGER_STATUS.PENDING && !session)
    await settleWallet(reservation.wallet);
  const closing = await CoinTransaction.find({
    relatedTxn: reservation._id,
    type: { $in: [T.DEBIT, T.RELEASE] },
  }).session(session);
  return {
    reservation,
    debit: closing.find((r) => r.type === T.DEBIT) ?? null,
    release: closing.find((r) => r.type === T.RELEASE) ?? null,
  };
}

/** Spends a reservation (the order was paid or placed with cash). Exactly once. */
export async function commitReservation(userId, { reserveKey, description }, options = {}) {
  return execute(
    userId,
    `${reserveKey}:commit`,
    async (_state, { session }) => {
      const { reservation, release } = await findReservation(userId, reserveKey, session);
      if (release) throw conflict("These coins were already released", "RESERVATION_CLOSED");
      return {
        type: T.DEBIT,
        source: S.COIN_REDEMPTION,
        coins: reservation.coins,
        relatedTxn: reservation._id,
        order: reservation.order,
        description: description ?? `${reservation.coins} coins redeemed`,
      };
    },
    options,
  );
}

/** Gives a reservation back (payment never completed, order closed). Exactly once. */
export async function releaseReservation(userId, { reserveKey, description }, options = {}) {
  const config = await getRewardConfig();
  return execute(
    userId,
    `${reserveKey}:release`,
    async (_state, { session, now }) => {
      const { reservation, debit } = await findReservation(userId, reserveKey, session);
      if (debit) throw conflict("These coins were already redeemed", "RESERVATION_CLOSED");
      return {
        type: T.RELEASE,
        source: S.COIN_REDEMPTION,
        coins: reservation.coins,
        allocations: restoreAllocations(reservation.allocations, config, now),
        relatedTxn: reservation._id,
        order: reservation.order,
        description: description ?? `${reservation.coins} coins returned to your wallet`,
      };
    },
    options,
  );
}

/** Gives back coins that were spent on an order that was then cancelled. Exactly once. */
export async function refundRedemption(userId, { reserveKey, description }, options = {}) {
  const config = await getRewardConfig();
  return execute(
    userId,
    `${reserveKey}:refund`,
    async (_state, { session, now }) => {
      const { reservation, debit } = await findReservation(userId, reserveKey, session);
      if (!debit) throw conflict("These coins were not redeemed", "NOT_REDEEMED");
      return {
        type: T.REVERSAL,
        reversalOf: REVERSAL_OF.REDEMPTION,
        source: S.COIN_REDEMPTION,
        coins: debit.coins,
        allocations: restoreAllocations(reservation.allocations, config, now),
        relatedTxn: debit._id,
        order: reservation.order,
        description: description ?? `${debit.coins} redeemed coins refunded`,
      };
    },
    options,
  );
}

/**
 * Claws back coins from an earned credit (refund of a rewarded order, fraud). `coins` defaults to
 * everything not yet reversed; partial reversals add up to at most the original credit. Coins
 * come from that credit's batch first, then FIFO; coins already spent are recorded as a
 * shortfall instead of making the wallet negative. Each reversal needs its own `key`.
 */
export async function reverseCredit(
  userId,
  { creditKey, coins, key, description, note, createdBy },
  options = {},
) {
  if (coins !== undefined) assertCoins(coins);
  return execute(
    userId,
    key,
    async (state, { session, now }) => {
      const original = await CoinTransaction.findOne({
        idempotencyKey: creditKey,
        user: userId,
        type: T.CREDIT,
      }).session(session);
      if (!original) throw ApiError.notFound("Reward not found");
      const previous = await CoinTransaction.find({
        relatedTxn: original._id,
        type: T.REVERSAL,
        reversalOf: REVERSAL_OF.CREDIT,
      }).session(session);
      const reversible = original.coins - sum(previous, (r) => r.requestedCoins ?? r.coins);
      const requested = coins ?? reversible;
      if (reversible <= 0) throw conflict("This reward was already reversed", "ALREADY_REVERSED");
      if (requested > reversible)
        throw conflict(`Only ${reversible} coins of this reward can still be reversed`, "REVERSAL_TOO_LARGE");
      const { allocations, taken } = takeFifo(state.batches, requested, {
        now,
        includeOverdue: true,
        preferOrigin: original._id,
      });
      return {
        type: T.REVERSAL,
        reversalOf: REVERSAL_OF.CREDIT,
        source: S.REWARD_REVERSAL,
        coins: taken,
        requestedCoins: requested,
        shortfall: requested - taken,
        allocations: allocations.length ? allocations : undefined,
        relatedTxn: original._id,
        order: original.order,
        campaign: original.campaign,
        referral: original.referral,
        description: description ?? `${requested} reward coins reversed`,
        note,
        createdBy,
      };
    },
    options,
  );
}

/** Expires one batch if it is past its expiry date. Idempotent per batch. */
async function expireBatch(userId, batchId, options = {}) {
  const config = await getRewardConfig();
  return execute(
    userId,
    `expire:${batchId}`,
    (state, { now }) => {
      if (!config.expiry.enabled) return null;
      const batch = state.batches.find((b) => sameId(b._id, batchId));
      if (!batch || batch.remaining === 0 || !isOverdue(batch, now)) return null;
      return {
        type: T.EXPIRE,
        source: S.COIN_EXPIRY,
        coins: batch.remaining,
        allocations: [allocationFrom(batch, batch.remaining)],
        relatedTxn: batch.origin,
        description: `${batch.remaining} coins expired`,
      };
    },
    options,
  );
}

/** Rewards sweep: expires every overdue batch (bounded per run). Returns coins and rows. */
export async function expireDueCoins({ now = new Date(), limit = 200 } = {}) {
  const summary = { wallets: 0, batches: 0, coins: 0 };
  const config = await getRewardConfig();
  if (!config.expiry.enabled) return summary;
  const wallets = await CoinWallet.find({
    batches: { $elemMatch: { expiresAt: { $ne: null, $lte: now }, remaining: { $gt: 0 } } },
  })
    .select("user batches")
    .limit(limit)
    .lean();
  for (const wallet of wallets) {
    summary.wallets++;
    for (const batch of wallet.batches.filter((b) => isOverdue(b, now))) {
      try {
        const { txn, created } = await expireBatch(wallet.user, batch._id, { now });
        if (created) {
          summary.batches++;
          summary.coins += txn.coins;
        }
      } catch (err) {
        logger.error({ err, walletId: String(wallet._id) }, "Coin expiry failed for a batch");
      }
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Coins the customer can spend right now (one small read; used by every cart quote). */
export async function spendableCoins(userId, config, now = new Date()) {
  const wallet = await CoinWallet.findOne({ user: userId }).select("batches").lean();
  return spendable(toState(wallet), { now, expiryEnabled: config.expiry.enabled });
}

/** The customer's wallet: balances, rupee value and upcoming expiries. */
export async function walletSummary(userId, { now = new Date() } = {}) {
  const [wallet, config] = await Promise.all([
    CoinWallet.findOne({ user: userId }).lean(),
    getRewardConfig(),
  ]);
  const state = toState(wallet);
  const expiryOn = config.expiry.enabled;
  const available = spendable(state, { now, expiryEnabled: expiryOn });
  const live = state.batches.filter((b) => !expiryOn || !isOverdue(b, now));
  const soonBefore = new Date(now.getTime() + config.expiry.expiringSoonDays * DAY_MS);
  const dated = expiryOn ? live.filter((b) => b.expiresAt).sort(fifo) : [];
  const byDay = new Map();
  for (const b of dated) {
    const day = localDay(b.expiresAt, config.timezone);
    byDay.set(day, (byDay.get(day) ?? 0) + b.remaining);
  }
  return {
    available,
    reserved: state.reserved,
    totalEarned: state.totalEarned,
    totalRedeemed: state.totalRedeemed,
    totalExpired: state.totalExpired,
    totalReversed: state.totalReversed,
    valuePaise: coinsToPaise(available, config),
    expiring: {
      enabled: expiryOn,
      withinDays: config.expiry.expiringSoonDays,
      coins: sum(dated.filter((b) => b.expiresAt <= soonBefore), (b) => b.remaining),
      next: dated[0] ? { expiresAt: dated[0].expiresAt, coins: byDay.get(localDay(dated[0].expiresAt, config.timezone)) } : null,
      upcoming: [...byDay].slice(0, 6).map(([date, coins]) => ({ date, coins })),
    },
  };
}

/** One ledger row as the customer sees it (no staff notes or internal references). */
export function customerTxnView(row) {
  return {
    id: String(row._id),
    type: row.type,
    source: row.source,
    coins: row.coins,
    availableChange: row.availableAfter - row.availableBefore,
    reservedChange: row.reservedAfter - row.reservedBefore,
    balanceAfter: row.availableAfter,
    description: row.description ?? null,
    orderId: row.order ? String(row.order) : null,
    expiresAt: row.type === T.CREDIT ? (row.expiresAt ?? null) : undefined,
    createdAt: row.createdAt,
  };
}

/** The customer's ledger, newest first. */
export async function listTransactions(userId, { type, source } = {}, pagination) {
  const filter = { user: userId, status: LEDGER_STATUS.POSTED };
  if (type) filter.type = type;
  if (source) filter.source = source;
  const [rows, total] = await Promise.all([
    CoinTransaction.find(filter).sort({ seq: -1 }).skip(pagination.skip).limit(pagination.limit).lean(),
    CoinTransaction.countDocuments(filter),
  ]);
  return { items: rows.map(customerTxnView), pagination: paginationMeta(pagination, total) };
}

/**
 * Checks a wallet against its ledger: replays every row from zero and compares, and checks the
 * balance invariants. Finishes pending rows first. Used by tests and admin investigations.
 */
export async function reconcile(userId) {
  const wallet = await CoinWallet.findOne({ user: userId }).lean();
  if (!wallet) return { ok: true, issues: [], rows: 0 };
  await settleWallet(wallet._id);
  const [current, rows] = await Promise.all([
    CoinWallet.findById(wallet._id).lean(),
    CoinTransaction.find({ wallet: wallet._id }).sort({ seq: 1 }).lean(),
  ]);
  const issues = [];
  let replay = emptyState();
  rows.forEach((row, i) => {
    if (row.seq !== i + 1) issues.push(`Row ${row._id} has seq ${row.seq}, expected ${i + 1}`);
    if (row.status !== LEDGER_STATUS.POSTED) issues.push(`Row ${row._id} is ${row.status}`);
    try {
      replay = applyTxn(replay, row);
    } catch (error) {
      issues.push(error.message);
    }
  });
  const state = toState(current);
  for (const f of COUNTERS)
    if (replay[f] !== state[f]) issues.push(`${f}: wallet ${state[f]}, ledger ${replay[f]}`);
  const remaining = (s) =>
    JSON.stringify(s.batches.map((b) => [String(b._id), b.remaining]).sort());
  if (remaining(replay) !== remaining(state)) issues.push("Batches differ from the ledger");
  const net =
    state.totalEarned - state.totalRedeemed - state.totalExpired - state.totalReversed;
  if (net !== state.available + state.reserved)
    issues.push(`earned - redeemed - expired - reversed (${net}) != available + reserved (${state.available + state.reserved})`);
  if (state.available !== sum(state.batches, (b) => b.remaining))
    issues.push("available != sum of batches");
  return { ok: issues.length === 0, issues, rows: rows.length };
}
