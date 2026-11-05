import { hasPermission } from "../config/permissions.js";
import { User, USER_STATUS } from "../models/user.model.js";
import { ApiError } from "../utils/api-error.js";
import { verifyAccessToken } from "../utils/tokens.js";

export async function authenticate(req, _res, next) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return next(ApiError.unauthorized());

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (error) {
    const message =
      error.name === "TokenExpiredError"
        ? "Access token expired"
        : "Invalid access token";
    return next(
      new ApiError(401, message, {
        code:
          error.name === "TokenExpiredError" ? "TOKEN_EXPIRED" : "UNAUTHORIZED",
      }),
    );
  }

  const user = await User.findById(payload.sub).select("+tokenVersion");
  if (
    !user ||
    user.status !== USER_STATUS.ACTIVE ||
    user.tokenVersion !== payload.tv
  ) {
    return next(ApiError.unauthorized("Session is no longer valid"));
  }

  req.user = user;
  next();
}

export const authorize =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) return next(ApiError.forbidden());
    next();
  };

/** Allows the request when the signed-in user's role has any of the given permissions. */
export const can =
  (...permissions) =>
  (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!permissions.some((p) => hasPermission(req.user.role, p)))
      return next(ApiError.forbidden("You do not have access to this area"));
    next();
  };
