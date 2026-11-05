import mongoose from "mongoose";

export const PAYOUT_TYPES = Object.freeze({ RESTAURANT: "restaurant", RIDER: "rider" });
export const PAYOUT_STATUS = Object.freeze({
  PENDING: "pending",
  PAID: "paid",
  CANCELLED: "cancelled",
});

/**
 * One payment from BiteBox to a restaurant or rider, covering a batch of delivered orders
 * (each order points back here through `order.payouts.restaurant` / `.rider`).
 */
const payoutSchema = new mongoose.Schema(
  {
    type: { type: String, enum: Object.values(PAYOUT_TYPES), required: true },
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: "Restaurant" },
    payee: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    payeeName: { type: String, required: true },
    orders: { type: Number, default: 0, min: 0 },
    amountPaise: { type: Number, default: 0, min: 0 },
    periodFrom: Date,
    periodTo: Date,
    status: {
      type: String,
      enum: Object.values(PAYOUT_STATUS),
      default: PAYOUT_STATUS.PENDING,
    },
    reference: { type: String, maxlength: 120 }, // bank / UPI transfer id
    note: { type: String, maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    paidAt: Date,
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

payoutSchema.index({ type: 1, status: 1, createdAt: -1 });
payoutSchema.index({ payee: 1, createdAt: -1 });

export const Payout = mongoose.model("Payout", payoutSchema);
