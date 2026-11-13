import mongoose from "mongoose";

/** External channels beside the in-app inbox (which every notification uses). */
export const CHANNELS = Object.freeze({ PUSH: "push", FCM: "fcm", EMAIL: "email", SMS: "sms" });
export const DELIVERY_STATUS = Object.freeze({
  QUEUED: "queued",
  SENT: "sent",
  FAILED: "failed", // retried at nextAttemptAt
  DEAD: "dead", // gave up (dead letter): admins can retry it
  SKIPPED: "skipped", // nothing to send to any more
});

/** One notification on one external channel: its status, tries and last error. */
const deliverySchema = new mongoose.Schema(
  {
    notification: { type: mongoose.Schema.Types.ObjectId, ref: "Notification", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    channel: { type: String, enum: Object.values(CHANNELS), required: true },
    status: {
      type: String,
      enum: Object.values(DELIVERY_STATUS),
      default: DELIVERY_STATUS.QUEUED,
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null, maxlength: 500 },
    nextAttemptAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
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

deliverySchema.index({ notification: 1, channel: 1 }, { unique: true });
deliverySchema.index({ status: 1, nextAttemptAt: 1 });
deliverySchema.index({ status: 1, createdAt: -1 });
// Kept as long as the inbox rows (90 days).
deliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const NotificationDelivery = mongoose.model("NotificationDelivery", deliverySchema);
