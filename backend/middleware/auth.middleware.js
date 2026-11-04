import { User, USER_STATUS } from "../models/user.model.js";
import { ApiError } from "../utils/api-error.js";
import { verifyAccessToken } from "../utils/tokens.js";

/**
 * Requires a valid `Authorization: Bearer <access token>` header.
 * The user is re-loaded on every request so suspensions and password
 * changes take effect immediately (tokenVersion check).
 */
export async function authenticate(req, _res, next) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return next(ApiError.unauthorized());

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (error) {
    const message = error.name === "TokenExpiredError" ? "Access token expired" : "Invalid access token";
    return next(new ApiError(401, message, { code: error.name === "TokenExpiredError" ? "TOKEN_EXPIRED" : "UNAUTHORIZED" }));
  }

  const user = await User.findById(payload.sub).select("+tokenVersion");
  if (!user || user.status !== USER_STATUS.ACTIVE || user.tokenVersion !== payload.tv) {
    return next(ApiError.unauthorized("Session is no longer valid"));
  }

  req.user = user;
  next();
}

/** Restricts a route to the given roles. Must run after `authenticate`. */
export const authorize =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) return next(ApiError.forbidden());
    next();
  };
