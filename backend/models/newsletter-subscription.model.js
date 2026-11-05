import mongoose from "mongoose";

/** One email on the marketing newsletter list. Stores only what sending it needs. */
const newsletterSubscriptionSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email address"],
    },
    status: { type: String, enum: ["subscribed", "unsubscribed"], default: "subscribed" },
    // Where they signed up (e.g. "footer"), for reporting only.
    source: { type: String, maxlength: 40, default: "footer" },
    subscribedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

newsletterSubscriptionSchema.index({ email: 1 }, { unique: true });

export const NewsletterSubscription = mongoose.model(
  "NewsletterSubscription",
  newsletterSubscriptionSchema,
);
