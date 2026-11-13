import mongoose from "mongoose";

/**
 * The restaurant commission (basis points of the food value after the coupon). No restaurant =
 * the global rate; a restaurant's own rule overrides it. Changing a rate closes the open rule
 * (`effectiveTo`) and opens a new one, so every rate stays in the history.
 */
const commissionRuleSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: "Restaurant", default: null },
    basisPoints: { type: Number, required: true, min: 0, max: 10_000 },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
    note: { type: String, maxlength: 300 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

// One open rule per scope (restaurant null = global).
commissionRuleSchema.index(
  { restaurant: 1 },
  { unique: true, partialFilterExpression: { effectiveTo: null } },
);
commissionRuleSchema.index({ effectiveFrom: -1 });

export const CommissionRule = mongoose.model("CommissionRule", commissionRuleSchema);
