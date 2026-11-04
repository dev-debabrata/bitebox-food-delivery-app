import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, required: true, maxlength: 40 }, // e.g. "order.confirmed"
    title: { type: String, required: true, maxlength: 120 },
    body: { type: String, maxlength: 300 },
    link: { type: String, maxlength: 200 },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
    readAt: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.user;
        return ret;
      },
    },
  },
);

notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, readAt: 1 });
notificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 },
);

export const Notification = mongoose.model("Notification", notificationSchema);
