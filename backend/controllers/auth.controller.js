import { env } from "../config/env.js";
import * as authService from "../services/auth.service.js";
import { respond, sendSuccess } from "../utils/api-response.js";

const cookieOptions = () => ({
  httpOnly: true,
  secure: env.isProduction,
  // The web app reaches the API through a same-origin /api proxy, so the cookie is first-party.
  // Set COOKIE_SAMESITE=none only if the browser calls the API on a different site.
  sameSite: process.env.COOKIE_SAMESITE || "strict",
  path: "/api/v1/auth",
  maxAge: env.refreshToken.ttlDays * 86_400_000,
});

const requestMeta = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") });

const getRefreshToken = (req) => req.cookies?.[env.refreshToken.cookieName];

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
      getRefreshToken(req),
      requestMeta(req),
    );
    sendSession(res, session, "Session refreshed");
  } catch (error) {
    if (error.code !== "REFRESH_RACE") clearSessionCookie(res);
    throw error;
  }
}

export async function logout(req, res) {
  await authService.logout(getRefreshToken(req));
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

// Phone codes and email verification.
export const methods = respond(() => authService.authMethods(), "Sign-in methods");
export const requestSignupCode = respond(
  (req) => authService.requestSignupCode(req.body, req.ip),
  "We have sent a code to your phone",
);
// The same answer whether or not the number has an account.
export const requestOtp = respond(
  (req) => authService.requestLoginCode(req.body.phone, req.ip),
  "If this number has a BiteBox account, we have sent a code",
);
export const requestPhoneVerification = respond(
  (req) => authService.requestPhoneVerification(req.user, req.ip),
  "We have sent a code to your phone",
);
export const verifyPhone = respond(
  async (req) => ({ user: (await authService.verifyPhone(req.user, req.body.code)).toJSON() }),
  "Phone number verified",
);
export const resendEmailVerification = respond(
  (req) => authService.resendEmailVerification(req.user).then(() => null),
  "We have sent you a new link",
);
export const verifyEmail = respond(
  (req) => authService.verifyEmail(req.body.token).then(() => null),
  "Email verified",
);

export async function otpLogin(req, res) {
  const session = await authService.loginWithCode(req.body, requestMeta(req));
  sendSession(res, session, "Signed in successfully");
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
