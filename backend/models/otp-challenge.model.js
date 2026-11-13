import mongoose from "mongoose";

export const OTP_PURPOSES = Object.freeze({
  LOGIN: "login", // sign in with a phone number
  VERIFY_PHONE: "verify_phone", // a signed-in person confirms their number
  REGISTER: "register", // a new account confirms its number before it is created
});

/**
 * One 6-digit code sent by SMS (services/otp.service.js; Django apps/accounts OtpChallenge). Only
 * an HMAC of the code is stored. Rows are also the rate-limit record, and MongoDB removes them a
 * day after they were created.
 */
const otpChallengeSchema = new mongoose.Schema(
  {
    purpose: { type: String, enum: Object.values(OTP_PURPOSES), required: true },
    phone: { type: String, required: true, maxlength: 16 },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0, min: 0 },
    consumedAt: { type: Date, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

otpChallengeSchema.index({ phone: 1, purpose: 1, createdAt: -1 });
otpChallengeSchema.index({ ip: 1, createdAt: -1 });
otpChallengeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export const OtpChallenge = mongoose.model("OtpChallenge", otpChallengeSchema);
