import { Server } from "socket.io";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { isAllowedOrigin } from "../middleware/security.middleware.js";
import { Restaurant } from "../models/restaurant.model.js";
import { ROLES, User, USER_STATUS } from "../models/user.model.js";
import { verifyAccessToken } from "../utils/tokens.js";
import { rooms, setRealtimeServer } from "./events.js";
import { registerTracking } from "./tracking.js";

export function attachRealtime(httpServer) {
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: {
      origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
      credentials: true,
    },
    maxHttpBufferSize: 10_000,
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== "string" || !token)
        return next(unauthorized("Authentication required"));
      const payload = verifyAccessToken(token);
      const user = await User.findById(payload.sub).select(
        "+tokenVersion role status",
      );
      if (
        !user ||
        user.status !== USER_STATUS.ACTIVE ||
        user.tokenVersion !== payload.tv
      ) {
        return next(unauthorized("Session is no longer valid"));
      }
      socket.data.user = { id: String(user._id), role: user.role };
      socket.data.expiresAt = payload.exp * 1000;
      next();
    } catch (error) {
      next(
        unauthorized(
          error.name === "TokenExpiredError"
            ? "Access token expired"
            : "Invalid access token",
        ),
      );
    }
  });

  io.on("connection", async (socket) => {
    const { id, role } = socket.data.user;
    registerTracking(io, socket);
    const joined = [rooms.user(id)];
    if (role === ROLES.ADMIN) joined.push(rooms.admins);
    if (role === ROLES.RESTAURANT) {
      const restaurant = await Restaurant.findOne({ owner: id }).select("_id");
      if (restaurant) joined.push(rooms.restaurant(restaurant._id));
    }
    await socket.join(joined);

    const ttl = Math.max(0, socket.data.expiresAt - Date.now());
    const expiry = setTimeout(() => socket.disconnect(true), ttl);
    socket.on("disconnect", () => clearTimeout(expiry));
  });

  setRealtimeServer(io);
  logger.info("Socket.IO connected");
  return io;
}

function unauthorized(message) {
  const error = new Error(message);
  error.data = { code: "UNAUTHORIZED" };
  return error;
}
