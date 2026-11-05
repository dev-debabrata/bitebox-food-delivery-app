import mongoose from "mongoose";
import {
  COIN_SOURCES,
  COIN_TXN_TYPES,
  EARN_SOURCES,
  REVERSAL_OF,
} from "../config/rewards.js";


export const LEDGER_STATUS = Object.freeze({
  // Written, not yet applied to the wallet (only ever seen briefly, or after a crash).
  PENDING: "pending",
  POSTED: "posted",
});

const ObjectId = mongoose.Schema.Types.ObjectId;
const coins = { type: Number, required: true, min: 0, validate: Number.isInteger };

/** Coins taken from (or given back to) one credit batch. */
const allocationSchema = new mongoose.Schema(
  {
    batch: { type: ObjectId, required: true },
    origin: { type: ObjectId, required: true },
    source: { type: String, enum: EARN_SOURCES, required: true },
    earnedAt: { type: Date, required: true },
    expiresAt: { type: Date, default: null },
    coins: { ...coins, min: 1 },
  },
  { _id: false },
);

/**
 * The coin ledger: one immutable row per wallet operation, numbered per wallet by `seq`.
 * The wallet balances are derived from these rows (services/coin-wallet.service.js#applyTxn).
 *
 * Rows are never edited or deleted. The only allowed write after insert is pending -> posted;
 * the middleware below rejects anything else made through Mongoose.
 */
const coinTransactionSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    wallet: { type: ObjectId, ref: "CoinWallet", required: true },
    seq: { type: Number, required: true, min: 1 },
    type: { type: String, enum: Object.values(COIN_TXN_TYPES), required: true },
    source: { type: String, enum: Object.values(COIN_SOURCES), required: true },
    reversalOf: { type: String, enum: Object.values(REVERSAL_OF), default: undefined },
    coins,
    // For clawbacks: what was asked for (coins may be less when they were already spent).
    requestedCoins: { type: Number, min: 0, default: undefined },
    shortfall: { type: Number, min: 0, default: undefined },

    availableBefore: { type: Number, required: true },
    availableAfter: { type: Number, required: true },
    reservedBefore: { type: Number, required: true },
    reservedAfter: { type: Number, required: true },

    allocations: { type: [allocationSchema], default: undefined },
    expiresAt: { type: Date, default: undefined }, // CREDIT: when these coins expire (null = never)

    order: { type: ObjectId, ref: "Order", default: undefined },
    campaign: { type: ObjectId, ref: "RewardCampaign", default: undefined },
    referral: { type: ObjectId, ref: "Referral", default: undefined },
    // The row this one settles or undoes (a reservation, or the credit being reversed).
    relatedTxn: { type: ObjectId, ref: "CoinTransaction", default: undefined },

    idempotencyKey: { type: String, required: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 300 },
    note: { type: String, trim: true, maxlength: 500 }, // staff-only
    createdBy: { type: ObjectId, ref: "User", default: undefined }, // staff action

    status: {
      type: String,
      enum: Object.values(LEDGER_STATUS),
      default: LEDGER_STATUS.PENDING,
    },
    createdAt: { type: Date, required: true, default: Date.now },
    postedAt: { type: Date, default: null },
  },
  {
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

coinTransactionSchema.index({ wallet: 1, seq: 1 }, { unique: true });
coinTransactionSchema.index({ idempotencyKey: 1 }, { unique: true });
coinTransactionSchema.index({ user: 1, seq: -1 });
coinTransactionSchema.index({ user: 1, type: 1, source: 1, seq: -1 });
coinTransactionSchema.index({ relatedTxn: 1, type: 1 });
coinTransactionSchema.index({ order: 1 }, { sparse: true });
coinTransactionSchema.index({ type: 1, source: 1, createdAt: -1 });
coinTransactionSchema.index(
  { createdAt: 1 },
  {
    name: "pending_rows",
    partialFilterExpression: { status: LEDGER_STATUS.PENDING },
  },
);

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

const immutable = () =>
  Object.assign(new Error("Coin transactions are immutable"), {
    code: "LEDGER_IMMUTABLE",
  });

/** The single permitted update: { status: "pending" } -> $set { status: "posted", postedAt }. */
function isPostingUpdate(query) {
  const update = query.getUpdate() ?? {};
  const keys = Object.keys(update);
  if (keys.length !== 1 || keys[0] !== "$set") return false;
  const set = update.$set ?? {};
  const setKeys = Object.keys(set).sort();
  return (
    setKeys.join(",") === "postedAt,status" &&
    set.status === LEDGER_STATUS.POSTED &&
    query.getFilter()?.status === LEDGER_STATUS.PENDING
  );
}

for (const op of ["updateOne", "updateMany"]) {
  coinTransactionSchema.pre(op, { query: true, document: false }, function guard() {
    if (!isPostingUpdate(this)) throw immutable();
  });
}
for (const op of [
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
  "deleteMany",
  "findOneAndDelete",
]) {
  coinTransactionSchema.pre(op, function guard() {
    throw immutable();
  });
}
coinTransactionSchema.pre("deleteOne", { query: true, document: true }, function guard() {
  throw immutable();
});
coinTransactionSchema.pre("updateOne", { query: false, document: true }, function guard() {
  throw immutable();
});
coinTransactionSchema.pre("save", function guard() {
  if (!this.isNew) throw immutable();
});
coinTransactionSchema.pre("bulkWrite", function guard() {
  throw immutable();
});

export const CoinTransaction = mongoose.model(
  "CoinTransaction",
  coinTransactionSchema,
);
