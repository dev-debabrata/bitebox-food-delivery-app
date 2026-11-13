import mongoose from "mongoose";

/** An FCM registration token of a native app install (none until the apps exist). */
const deviceTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    token: { type: String, required: true, maxlength: 500 },
    platform: { type: String, enum: ["android", "ios"], required: true },
    lastSuccessAt: { type: Date, default: null },
    failures: { type: Number, default: 0 },
  },
  { timestamps: true },
);

deviceTokenSchema.index({ token: 1 }, { unique: true });
deviceTokenSchema.index({ user: 1, updatedAt: -1 });

export const DeviceToken = mongoose.model("DeviceToken", deviceTokenSchema);
