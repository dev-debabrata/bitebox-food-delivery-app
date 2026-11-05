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
import { notifyAdmins } from "./notification.service.js";
import * as referralService from "./referral.service.js";
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
  { name, email, phone, password, role = ROLES.CUSTOMER, referralCode },
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

  const existing = await User.exists({ email });
  if (existing)
    throw ApiError.conflict("An account with this email already exists");
  if (phone && (await User.exists({ phone }))) {
    throw ApiError.conflict("An account with this phone number already exists");
  }

  const user = await User.create({
    name,
    email,
    phone,
    role,
    passwordHash: await hashPassword(password),
  });
  logger.info({ userId: user.id, role }, "User registered");
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
  user.tokenVersion += 1;
  await user.save();
  await revokeAllSessions(user._id, "password-change");
}

export async function updateProfile(userId, { name, phone }) {
  if (phone && (await User.exists({ phone, _id: { $ne: userId } }))) {
    throw ApiError.conflict("An account with this phone number already exists");
  }
  const set = {};
  const unset = {};
  if (name !== undefined) set.name = name;
  if (phone === "" || phone === null) unset.phone = 1;
  else if (phone !== undefined) set.phone = phone;

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
