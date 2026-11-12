import mongoose from "mongoose";

/**
 * One browser's Web Push subscription. The endpoint (unique) identifies the browser; the keys
 * encrypt the payload for it. A browser belongs to whoever signed in on it last, so subscribing
 * again from another account moves the row instead of duplicating it.
 */
const pushSubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    endpoint: { type: String, required: true, maxlength: 1000 },
    keys: {
      p256dh: { type: String, required: true, maxlength: 200 },
      auth: { type: String, required: true, maxlength: 100 },
    },
    expirationTime: { type: Date, default: null },
    // Short device label for the user's own reference ("Chrome on Android").
    device: { type: String, maxlength: 80, default: "" },
    lastSuccessAt: { type: Date, default: null },
    // Consecutive failures that were not "gone" (404/410); the row is dropped after a few.
    failures: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.keys; // never sent back to any client
        delete ret.user;
        return ret;
      },
    },
  },
);

pushSubscriptionSchema.index({ endpoint: 1 }, { unique: true });
pushSubscriptionSchema.index({ user: 1, updatedAt: -1 });

export const PushSubscription = mongoose.model(
  "PushSubscription",
  pushSubscriptionSchema,
);
