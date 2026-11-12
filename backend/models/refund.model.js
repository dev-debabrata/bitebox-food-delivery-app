import mongoose from "mongoose";

/**
 * One refund of a payment (full or partial). Online refunds go through the gateway
 * (pending → processing → processed | failed); cash refunds are paid back by hand
 * (manual_pending → manual_done). Only services/payments/payment.service.js changes them.
 */
export const REFUND_STATUS = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  PROCESSED: "processed",
  FAILED: "failed",
  MANUAL_PENDING: "manual_pending",
  MANUAL_DONE: "manual_done",
});

const refundSchema = new mongoose.Schema(
  {
    payment: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    amountPaise: { type: Number, required: true, min: 1 },
    reason: { type: String, trim: true, maxlength: 300 },
    status: {
      type: String,
      enum: Object.values(REFUND_STATUS),
      default: REFUND_STATUS.PENDING,
    },
    providerRefundId: { type: String, default: null },
    // Deterministic for system refunds (order-closed:<orderId>); one per admin request.
    idempotencyKey: { type: String, required: true, maxlength: 160 },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    failureReason: { type: String, default: null },
    processedAt: { type: Date, default: null },
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

refundSchema.index({ idempotencyKey: 1 }, { unique: true });
refundSchema.index(
  { providerRefundId: 1 },
  { unique: true, partialFilterExpression: { providerRefundId: { $type: "string" } } },
);
refundSchema.index({ payment: 1, createdAt: 1 });
refundSchema.index({ status: 1, updatedAt: 1 });

export const Refund = mongoose.model("Refund", refundSchema);
