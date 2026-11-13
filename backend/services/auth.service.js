import { PERMISSIONS } from "../config/permissions.js";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { Session } from "../models/session.model.js";
import {
  ROLES,
  SELF_REGISTER_ROLES,
  User,
  USER_STATUS,
} from "../models/user.model.js";
import { ApiError } from "../utils/api-error.js";
import { hashToken, randomToken, signAccessToken } from "../utils/tokens.js";
import { sendMail } from "./mail.service.js";
import { notify, notifyAdmins } from "./notification.service.js";
import { CHANNELS } from "../models/notification-delivery.model.js";
import { OTP_PURPOSES } from "../models/otp-challenge.model.js";
import { channelEnabled } from "./notification-channels.js";
import * as otp from "./otp.service.js";
import * as referralService from "./referral.service.js";
import { isUploadedImageUrl } from "./upload.service.js";
import * as rewardEvents from "./reward-events.js";

const ROTATION_GRACE_MS = 15_000;

// Used to keep login timing similar whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync("bitebox-timing-equaliser", 4);

export const hashPassword = (password) => bcrypt.hash(password, env.bcryptRounds);

async function createSession(user, meta, family = crypto.randomUUID()) {
  const refreshToken = randomToken();
  await Session.create({
    user: user._id,
    tokenHash: hashToken(refreshToken),
    family,
    expiresAt: new Date(Date.now() + env.refreshToken.ttlDays * 86_400_000),
    userAgent: meta.userAgent?.slice(0, 512),
    ip: meta.ip,
  });
  return refreshToken;
}

async function issueTokens(user, meta, family) {
  const refreshToken = await createSession(user, meta, family);
  return {
    user: user.toJSON(),
    accessToken: signAccessToken(user),
    refreshToken,
  };
}

async function revokeAllSessions(userId, reason) {
  await Session.updateMany(
    { user: userId, revokedAt: null },
    { revokedAt: new Date(), revokedReason: reason },
  );
}

/**
 * Saves `user` (with any pending changes) and signs them out everywhere: old access tokens
 * fail (`tokenVersion`, incremented atomically whether or not it was loaded) and refresh
 * tokens are revoked.
 */
export async function endSessions(user, reason) {
  user.$inc("tokenVersion", 1);
  await user.save();
  await revokeAllSessions(user._id, reason);
}

/** Partner sign-ups admins are told about (customers sign up too often to notify). */
const PARTNER_SIGNUP = {
  [ROLES.RESTAURANT]: {
    what: "restaurant partner",
    link: "/admin/users",
    permission: PERMISSIONS.USERS_MANAGE,
  },
  [ROLES.DELIVERY]: {
    what: "delivery partner",
    link: "/admin/delivery-partners",
    permission: PERMISSIONS.RIDERS_MANAGE,
  },
};

export async function register(
  { name, email, phone, password, role = ROLES.CUSTOMER, referralCode, code },
  meta,
) {
  if (!SELF_REGISTER_ROLES.includes(role)) {
    throw ApiError.forbidden("This role cannot be self-registered");
  }
  // Referral codes are for customers; check the code before creating the account.
  const referral =
    referralCode && role === ROLES.CUSTOMER
      ? await referralService.resolveCode(referralCode)
      : null;

  await checkNewAccount(email, phone);
  let phoneVerifiedAt;
  if (signupNeedsCode()) {
    // Step 2: the account is created only with the code texted to its number.
    if (!phone) throw ApiError.badRequest("Enter your mobile number", [{ field: "phone", message: "Enter your mobile number" }]);
    if (!code) throw ApiError.badRequest("Enter the code we sent to your phone", [{ field: "code", message: "Enter the 6-digit code" }]);
    await otp.checkCode(phone, OTP_PURPOSES.REGISTER, code);
    phoneVerifiedAt = new Date();
  }

  const user = await User.create({
    name,
    email,
    phone,
    role,
    phoneVerifiedAt,
    passwordHash: await hashPassword(password),
  });
  logger.info({ userId: user.id, role }, "User registered");
  await sendEmailVerification(user).catch((err) =>
    logger.error({ err, userId: user.id }, "Could not send the verification email"),
  );
  const [title, welcomeBody, link] = WELCOME[role] ?? WELCOME.customer;
  await notify(user._id, { type: "account.welcome", title: title(name), body: welcomeBody, link });
  if (role === ROLES.CUSTOMER)
    await rewardEvents.customerRegistered(user, { referral, ip: meta?.ip });
  const signup = PARTNER_SIGNUP[role];
  if (signup)
    await notifyAdmins({
      type: `user.${role}`,
      title: `New ${signup.what}: ${name}`,
      body: email,
      link: signup.link,
    }, signup.permission);
  return issueTokens(user, meta);
}

async function checkNewAccount(email, phone) {
  if (await User.exists({ email })) throw ApiError.conflict("An account with this email already exists");
  if (phone && (await User.exists({ phone })))
    throw ApiError.conflict("An account with this phone number already exists");
}

/** New accounts confirm their number by SMS first (env.signupOtpRequired, while SMS is on). */
/** What the sign-in and profile pages may offer: SMS codes only when an SMS provider is set up. */
export const authMethods = () => ({ phone: channelEnabled(CHANNELS.SMS) });
export const signupNeedsCode = () => (signupOverride ?? env.signupOtpRequired) && channelEnabled(CHANNELS.SMS);
let signupOverride = null;
/** Tests: require the sign-up code (true/false), or null for the configured behaviour. */
export const useSignupCode = (value) => (signupOverride = value);

/** Step 1 of sign-up: the email and number are free, so text a code to the number. */
export async function requestSignupCode({ email, phone }, ip) {
  await checkNewAccount(email, phone);
  return otp.sendCode(phone, OTP_PURPOSES.REGISTER, ip, true);
}

/** The welcome notification (in-app, and email when allowed) per role. */
const WELCOME = {
  customer: [(n) => `Welcome to BiteBox, ${n}!`, "Find a restaurant near you and order in minutes.", "/"],
  restaurant: [
    (n) => `Welcome to BiteBox, ${n}!`,
    "Add your restaurant details to start receiving orders.",
    "/restaurant/details",
  ],
  delivery: [(n) => `Welcome to BiteBox, ${n}!`, "Add your vehicle, go online and start earning.", "/delivery"],
};

export async function login({ email, password, portal }, meta) {
  const user = await User.findOne({ email }).select(
    "+passwordHash +tokenVersion",
  );
  const passwordOk = await bcrypt.compare(
    password,
    user?.passwordHash ?? DUMMY_HASH,
  );

  if (!user || !passwordOk)
    throw ApiError.unauthorized("Invalid email or password");
  return signedIn(user, portal, meta);
}

async function signedIn(user, portal, meta) {
  if (user.status !== USER_STATUS.ACTIVE)
    throw ApiError.forbidden("This account has been suspended");
  // Each panel has its own sign-in page; prevent e.g. a customer using the admin login.
  if (portal && user.role !== portal) {
    throw ApiError.forbidden("This account cannot sign in to this portal");
  }
  user.lastLoginAt = new Date();
  await user.save();
  return issueTokens(user, meta);
}

/** Sign in with the SMS code sent by otp.requestLoginCode (proves the number, too). */
export async function loginWithCode({ phone, code, portal }, meta) {
  await otp.checkCode(phone, OTP_PURPOSES.LOGIN, code);
  const user = await otp.loginUser(phone);
  if (!user) throw ApiError.unauthorized("That code is not right"); // no code was ever sent
  user.phoneVerifiedAt ??= new Date();
  return signedIn(user, portal, meta);
}

export const requestLoginCode = otp.requestLoginCode;

export async function requestPhoneVerification(user, ip) {
  if (!user.phone) throw ApiError.badRequest("Add a phone number to your profile first");
  if (user.phoneVerifiedAt) throw ApiError.conflict("Your phone number is already verified");
  return otp.sendCode(user.phone, OTP_PURPOSES.VERIFY_PHONE, ip, true);
}

export async function verifyPhone(user, code) {
  if (!user.phone) throw ApiError.badRequest("Add a phone number to your profile first");
  await otp.checkCode(user.phone, OTP_PURPOSES.VERIFY_PHONE, code);
  return User.findByIdAndUpdate(user._id, { phoneVerifiedAt: new Date() }, { returnDocument: "after" });
}

/** Emails a one-time link (env.emailVerification.ttlHours) that confirms the address. */
export async function sendEmailVerification(user) {
  if (user.emailVerifiedAt) return;
  const token = randomToken(32);
  const hours = env.emailVerification.ttlHours;
  await User.updateOne(
    { _id: user._id },
    { emailVerificationTokenHash: hashToken(token), emailVerificationExpiresAt: new Date(Date.now() + hours * 3_600_000) },
  );
  const link = `${env.clientUrls[0]}/verify-email?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    subject: "Confirm your BiteBox email",
    text: `Hi ${user.name},\n\nConfirm this is your email address for BiteBox:\n\n${link}\n\nThe link works for ${hours} hours. If you did not create an account, ignore this email.`,
    html: `<p>Hi ${escapeHtml(user.name)},</p><p>Confirm this is your email address for BiteBox.</p><p><a href="${link}">Confirm email</a></p><p>The link works for ${hours} hours. If you did not create an account, ignore this email.</p>`,
  });
}

export async function resendEmailVerification(user) {
  if (user.emailVerifiedAt) throw ApiError.conflict("Your email is already verified");
  await sendEmailVerification(user);
}

export async function verifyEmail(token) {
  // Consume the token atomically so it works once.
  const user = await User.findOneAndUpdate(
    { emailVerificationTokenHash: hashToken(token), emailVerificationExpiresAt: { $gt: new Date() } },
    { $set: { emailVerifiedAt: new Date() }, $unset: { emailVerificationTokenHash: 1, emailVerificationExpiresAt: 1 } },
  );
  if (!user) throw ApiError.badRequest("This link is invalid or has expired. Ask for a new one");
}

/** Rotate a refresh token: the old one is atomically revoked and a new one issued. */
export async function refresh(rawToken, meta) {
  if (!rawToken) throw ApiError.unauthorized("No session");
  const tokenHash = hashToken(rawToken);

  // Atomically rotate valid token.
  let session = await Session.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: new Date() } },
    { revokedAt: new Date(), revokedReason: "rotated" },
  );

  if (!session) {
    const stale = await Session.findOne({ tokenHash });
    if (stale?.revokedReason === "rotated") {
      if (Date.now() - stale.revokedAt.getTime() < ROTATION_GRACE_MS) {
        session = stale; // Grace-period race: continue and reissue tokens for the active family.
      } else {
        await Session.updateMany(
          { family: stale.family, revokedAt: null },
          { revokedAt: new Date(), revokedReason: "reuse" },
        );
        logger.warn(
          { userId: String(stale.user) },
          "Refresh token reuse detected; session family revoked",
        );
      }
    }
    if (!session) throw ApiError.unauthorized("Session expired, please sign in again");
  }

  const user = await User.findById(session.user).select("+tokenVersion");
  if (!user || user.status !== USER_STATUS.ACTIVE) {
    throw ApiError.unauthorized("Session expired, please sign in again");
  }

  return issueTokens(user, meta, session.family);
}

export async function logout(rawToken) {
  if (!rawToken) return;
  await Session.updateOne(
    { tokenHash: hashToken(rawToken), revokedAt: null },
    { revokedAt: new Date(), revokedReason: "logout" },
  );
}

export async function forgotPassword(email) {
  const user = await User.findOne({ email, status: USER_STATUS.ACTIVE });
  // Always behave the same to avoid revealing which emails are registered.
  if (!user) return;

  const token = randomToken(32);
  user.passwordResetTokenHash = hashToken(token);
  user.passwordResetExpiresAt = new Date(
    Date.now() + env.passwordReset.ttlMinutes * 60_000,
  );
  await user.save();

  const link = `${env.clientUrls[0]}/reset-password?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    subject: "Reset your BiteBox password",
    text: `Hi ${user.name},\n\nUse this link to reset your BiteBox password. It expires in ${env.passwordReset.ttlMinutes} minutes and can only be used once:\n\n${link}\n\nIf you did not request this, you can ignore this email.`,
    html: `<p>Hi ${escapeHtml(user.name)},</p><p>Use the link below to reset your BiteBox password. It expires in ${env.passwordReset.ttlMinutes} minutes and can only be used once.</p><p><a href="${link}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`,
  });
}

export async function resetPassword(token, newPassword) {
  const passwordHash = await hashPassword(newPassword);
  // Atomically consume the token so it can only be used once.
  const user = await User.findOneAndUpdate(
    {
      passwordResetTokenHash: hashToken(token),
      passwordResetExpiresAt: { $gt: new Date() },
    },
    {
      $set: { passwordHash },
      $unset: { passwordResetTokenHash: 1, passwordResetExpiresAt: 1 },
      $inc: { tokenVersion: 1 },
    },
  );
  if (!user)
    throw ApiError.badRequest("This reset link is invalid or has expired");
  await revokeAllSessions(user._id, "password-change");
}

export async function changePassword(userId, currentPassword, newPassword) {
  const user = await User.findById(userId).select(
    "+passwordHash +tokenVersion",
  );
  if (!user) throw ApiError.notFound("User not found");
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw ApiError.badRequest("Current password is incorrect");
  }
  user.passwordHash = await hashPassword(newPassword);
  await endSessions(user, "password-change");
}

export async function updateProfile(userId, { name, phone, avatarUrl }) {
  if (phone && (await User.exists({ phone, _id: { $ne: userId } }))) {
    throw ApiError.conflict("An account with this phone number already exists");
  }
  if (avatarUrl && !isUploadedImageUrl(avatarUrl)) throw ApiError.badRequest("Upload the photo first");
  const current = await User.findById(userId).select("phone");
  const set = {};
  const unset = {};
  if (name !== undefined) set.name = name;
  if (phone === "" || phone === null) unset.phone = 1;
  else if (phone !== undefined) set.phone = phone;
  // A new number must be verified again.
  if (phone !== undefined && (phone || null) !== (current?.phone ?? null)) unset.phoneVerifiedAt = 1;
  if (avatarUrl === "" || avatarUrl === null) unset.avatarUrl = 1;
  else if (avatarUrl !== undefined) set.avatarUrl = avatarUrl;

  const user = await User.findByIdAndUpdate(
    userId,
    {
      ...(Object.keys(set).length && { $set: set }),
      ...(Object.keys(unset).length && { $unset: unset }),
    },
    { returnDocument: "after", runValidators: true },
  );
  if (!user) throw ApiError.notFound("User not found");
  return user;
}

export { revokeAllSessions };

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
