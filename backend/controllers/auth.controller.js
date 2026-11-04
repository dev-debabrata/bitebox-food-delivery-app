import { env } from "../config/env.js";
import * as authService from "../services/auth.service.js";
import { sendSuccess } from "../utils/api-response.js";

const cookieOptions = () => ({
  httpOnly: true,
  secure: env.isProduction,
  sameSite: process.env.COOKIE_SAMESITE || "strict",
  path: "/api/v1/auth",
  maxAge: env.refreshToken.ttlDays * 86_400_000,
});

const requestMeta = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") });

function sendSession(
  res,
  { user, accessToken, refreshToken },
  message,
  statusCode = 200,
) {
  res.cookie(env.refreshToken.cookieName, refreshToken, cookieOptions());
  return sendSuccess(res, { statusCode, message, data: { user, accessToken } });
}

function clearSessionCookie(res) {
  const { maxAge: _maxAge, ...options } = cookieOptions();
  res.clearCookie(env.refreshToken.cookieName, options);
}

export async function register(req, res) {
  const session = await authService.register(req.body, requestMeta(req));
  sendSession(res, session, "Account created successfully", 201);
}

export async function login(req, res) {
  const session = await authService.login(req.body, requestMeta(req));
  sendSession(res, session, "Signed in successfully");
}

export async function refresh(req, res) {
  try {
    const session = await authService.refresh(
      req.cookies?.[env.refreshToken.cookieName],
      requestMeta(req),
    );
    sendSession(res, session, "Session refreshed");
  } catch (error) {
    if (error.code !== "REFRESH_RACE") clearSessionCookie(res);
    throw error;
  }
}

export async function logout(req, res) {
  await authService.logout(req.cookies?.[env.refreshToken.cookieName]);
  clearSessionCookie(res);
  sendSuccess(res, { message: "Signed out successfully" });
}

export async function forgotPassword(req, res) {
  await authService.forgotPassword(req.body.email);
  sendSuccess(res, {
    message: "If an account exists for this email, a reset link has been sent",
  });
}

export async function resetPassword(req, res) {
  await authService.resetPassword(req.body.token, req.body.password);
  clearSessionCookie(res);
  sendSuccess(res, {
    message: "Password has been reset. Please sign in with your new password",
  });
}

export async function changePassword(req, res) {
  await authService.changePassword(
    req.user._id,
    req.body.currentPassword,
    req.body.newPassword,
  );
  clearSessionCookie(res);
  sendSuccess(res, { message: "Password changed. Please sign in again" });
}

export function me(req, res) {
  sendSuccess(res, { data: { user: req.user.toJSON() } });
}

export async function updateMe(req, res) {
  const user = await authService.updateProfile(req.user._id, req.body);
  sendSuccess(res, {
    message: "Profile updated",
    data: { user: user.toJSON() },
  });
}
