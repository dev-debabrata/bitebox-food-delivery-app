import mongoose from "mongoose";

export const LEDGER_ACCOUNTS = Object.freeze([
  "customer_payments", // money collected from customers
  "restaurant_payable", // owed to restaurants
  "rider_payable", // owed to riders
  "platform_revenue", // BiteBox's share (fees and commission)
  "tax_payable", // tax collected on orders
  "payouts", // money paid out to partners
]);

/**
 * Double-entry finance ledger (services/ledger.service.js). Each event is one `group` whose
 * signed amounts sum to zero, posted once (`key` + account is unique). Append-only: updates and
 * deletes are refused here (like the coin ledger).
 */
const ledgerEntrySchema = new mongoose.Schema(
  {
    group: { type: String, required: true },
    key: { type: String, required: true, maxlength: 120 },
    account: { type: String, enum: LEDGER_ACCOUNTS, required: true },
    amountPaise: { type: Number, required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    payout: { type: mongoose.Schema.Types.ObjectId, ref: "Payout", default: null },
    description: { type: String, maxlength: 200 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ledgerEntrySchema.index({ key: 1, account: 1 }, { unique: true });
ledgerEntrySchema.index({ group: 1 });
ledgerEntrySchema.index({ account: 1, createdAt: -1 });

const immutable = function () {
  throw new Error("LEDGER_IMMUTABLE: ledger rows cannot be changed");
};
for (const op of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
])
  ledgerEntrySchema.pre(op, immutable);
ledgerEntrySchema.pre("save", function () {
  if (!this.isNew) immutable();
});

export const LedgerEntry = mongoose.model("LedgerEntry", ledgerEntrySchema);
