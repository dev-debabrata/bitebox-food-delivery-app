import mongoose from "mongoose";
import { EARN_SOURCES } from "../config/rewards.js";

const count = { type: Number, default: 0, min: 0 };

/**
 * A live credit batch: coins from one reward (or coins given back by a cancelled order) that
 * share an expiry date. Spending, expiry and clawbacks take coins from batches, earliest expiry
 * first (FIFO). Fully used batches are removed; their history stays in the ledger.
 */
const batchSchema = new mongoose.Schema(
  {
    _id: { type: mongoose.Schema.Types.ObjectId, required: true },
    // The CREDIT ledger row these coins were first earned by.
    origin: { type: mongoose.Schema.Types.ObjectId, required: true },
    source: { type: String, enum: EARN_SOURCES, required: true },
    original: { type: Number, required: true, min: 1 },
    remaining: { type: Number, required: true, min: 0 },
    earnedAt: { type: Date, required: true },
    expiresAt: { type: Date, default: null },
  },
  { _id: false },
);

/**
 * A customer's coin wallet. The ledger (CoinTransaction) is the record of truth; these balances
 * are its running totals, advanced one ledger row at a time under `seq`. Only
 * services/coin-wallet.service.js writes to wallets.
 *
 * Invariants (see coin-wallet.service#reconcile):
 *   available == sum(batches.remaining)
 *   totalEarned - totalRedeemed - totalExpired - totalReversed == available + reserved
 */
const coinWalletSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    available: count,
    reserved: count,
    totalEarned: count,
    totalRedeemed: count, // net of redemptions refunded by cancelled orders
    totalExpired: count,
    totalReversed: count, // clawed back
    uncollectedReversal: count, // clawbacks that found the coins already spent
    seq: count, // the last ledger row applied to this wallet
    batches: { type: [batchSchema], default: [] },
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

coinWalletSchema.index({ user: 1 }, { unique: true });
// The expiry sweep looks for wallets with a batch past its expiry date.
coinWalletSchema.index({ "batches.expiresAt": 1 });

export const CoinWallet = mongoose.model("CoinWallet", coinWalletSchema);
