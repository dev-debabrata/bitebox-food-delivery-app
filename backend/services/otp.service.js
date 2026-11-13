import crypto from "node:crypto";
import { env } from "../config/env.js";
import { OTP_PURPOSES, OtpChallenge } from "../models/otp-challenge.model.js";
import { User, USER_STATUS } from "../models/user.model.js";
import { ApiError } from "../utils/api-error.js";
import { CHANNELS } from "../models/notification-delivery.model.js";
import { channelEnabled, deliverSms } from "./notification-channels.js";

/**
 * One-time codes by SMS (same rules as backend-django/apps/accounts/otp.py): sign in with a phone
 * number, or confirm a signed-in person's number.
 *
 * - 6 digits from crypto.randomInt; only an HMAC (keyed with the JWT secret) is stored.
 * - A code lives env.otp.ttlSeconds and allows env.otp.maxAttempts tries; a new one can be asked
 *   for after env.otp.resendSeconds, at most perPhonePerHour per number and perIpPerHour per IP.
 * - Sign-in requests get the same answer whether or not the number has an account (a code is only
 *   sent when it does), so the endpoint cannot be used to find out who is registered.
 */
const hash = (phone, code) =>
  crypto.createHmac("sha256", env.jwt.secret).update(`${phone}:${code}`).digest("hex");
const limit = (message) => new ApiError(429, message, { code: "OTP_RATE_LIMITED" });
const { otp } = env;

/** Creates a challenge (always) and texts the code when `send` (e.g. the number has an account). */
export async function sendCode(phone, purpose, ip, send) {
  if (!channelEnabled(CHANNELS.SMS))
    throw new ApiError(503, "We can't send text messages right now. Please try again later", {
      code: "SMS_UNAVAILABLE",
    });
  const now = Date.now();
  const last = await OtpChallenge.findOne({ phone, purpose }).sort({ createdAt: -1 });
  const wait = last ? otp.resendSeconds - (now - last.createdAt.getTime()) / 1000 : 0;
  if (wait > 0) throw limit(`Wait ${Math.floor(wait) + 1} seconds before asking for a new code`);
  const hourAgo = new Date(now - 60 * 60_000);
  if ((await OtpChallenge.countDocuments({ phone, purpose, createdAt: { $gte: hourAgo } })) >= otp.perPhonePerHour)
    throw limit("Too many codes for this number. Try again in an hour");
  if (ip && (await OtpChallenge.countDocuments({ ip, createdAt: { $gte: hourAgo } })) >= otp.perIpPerHour)
    throw limit("Too many codes requested. Try again in an hour");

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await OtpChallenge.create({
    purpose,
    phone,
    codeHash: hash(phone, code),
    expiresAt: new Date(now + otp.ttlSeconds * 1000),
    ip: ip ?? null,
  });
  if (send)
    await deliverSms(
      phone,
      `${code} is your BiteBox code. It expires in ${Math.floor(otp.ttlSeconds / 60)} minutes. Never share it.`,
      env.notifications.msg91OtpTemplateId,
    );
  return { resendInSeconds: otp.resendSeconds, expiresInSeconds: otp.ttlSeconds };
}

/** Uses up the latest live code for this number, or throws 400/429. Each try counts. */
export async function checkCode(phone, purpose, code) {
  const challenge = await OtpChallenge.findOne({
    phone,
    purpose,
    consumedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });
  if (!challenge) throw ApiError.badRequest("This code has expired. Ask for a new one");
  if (challenge.attempts >= otp.maxAttempts)
    throw new ApiError(429, "Too many wrong codes. Ask for a new one", { code: "OTP_LOCKED" });
  await OtpChallenge.updateOne({ _id: challenge._id }, { $inc: { attempts: 1 } });
  const expected = Buffer.from(challenge.codeHash);
  const given = Buffer.from(hash(phone, code));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    const left = otp.maxAttempts - challenge.attempts - 1;
    throw ApiError.badRequest(
      left
        ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left`
        : "That code is not right. Ask for a new one",
    );
  }
  // Exactly once, even if two requests carry the right code at the same moment.
  const used = await OtpChallenge.updateOne(
    { _id: challenge._id, consumedAt: null },
    { consumedAt: new Date() },
  );
  if (!used.modifiedCount) throw ApiError.badRequest("This code has already been used. Ask for a new one");
}

/** The ways one Indian mobile number may be stored: as typed, 10 digits, +91 and 91 prefixed. */
export function phoneForms(phone) {
  const digits = phone.replace(/\D/g, "");
  const forms = new Set([phone, digits, `+${digits}`]);
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    for (const f of [last10, `+91${last10}`, `91${last10}`]) forms.add(f);
  }
  return [...forms];
}

export const loginUser = (phone) =>
  User.findOne({ phone: { $in: phoneForms(phone) }, status: USER_STATUS.ACTIVE }).select("+tokenVersion");

export async function requestLoginCode(phone, ip) {
  return sendCode(phone, OTP_PURPOSES.LOGIN, ip, Boolean(await loginUser(phone)));
}
