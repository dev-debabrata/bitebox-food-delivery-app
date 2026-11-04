import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    tokenHash: { type: String, required: true },
    family: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    revokedReason: {
      type: String,
      enum: ["rotated", "logout", "reuse", "password-change", "suspended"],
    },
    userAgent: { type: String, maxlength: 512 },
    ip: { type: String, maxlength: 64 },
  },
  { timestamps: true },
);

sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ user: 1, revokedAt: 1 });
sessionSchema.index({ family: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model("Session", sessionSchema);
