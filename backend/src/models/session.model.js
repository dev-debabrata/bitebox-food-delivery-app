import mongoose from "mongoose";

/**
 * A refresh-token session. Raw refresh tokens are only ever in the
 * HttpOnly cookie; the database stores a SHA-256 hash.
 *
 * Tokens rotate on every refresh. All tokens descending from one login share
 * a `family`; presenting an already-rotated token revokes the whole family
 * (refresh-token reuse detection).
 */
const sessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    tokenHash: { type: String, required: true },
    family: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    revokedReason: { type: String, enum: ["rotated", "logout", "reuse", "password-change"] },
    userAgent: { type: String, maxlength: 512 },
    ip: { type: String, maxlength: 64 },
  },
  { timestamps: true },
);

sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ user: 1, revokedAt: 1 });
sessionSchema.index({ family: 1 });
// MongoDB removes expired sessions automatically.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model("Session", sessionSchema);
