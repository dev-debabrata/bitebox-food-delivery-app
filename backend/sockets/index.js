import { Server } from "socket.io";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { Restaurant } from "../models/restaurant.model.js";
import { ROLES, User, USER_STATUS } from "../models/user.model.js";
import { verifyAccessToken } from "../utils/tokens.js";
import { rooms, setRealtimeServer } from "./events.js";
import { registerTracking } from "./tracking.js";

/**
 * Socket.IO for live order updates.
 *
 * Security model:
 * - Every connection must present a valid access token (handshake `auth.token`); the user is
 *   re-loaded so suspended accounts and revoked tokens (tokenVersion) are refused.
 * - Rooms are derived on the server from that identity only (own user room, own restaurant,
 *   admins). The only client-requested room is an order's tracking room (track:join), granted
 *   after a database permission check (see tracking.js), so nobody can listen to others' orders.
 * - The connection is closed when the access token expires; the client reconnects with a fresh one.
 * - Events carry only ids and statuses. Clients re-read details through the authorised REST API,
 *   and MongoDB stays the source of truth (a missed event is caught by the client's fallback refresh).
 */
export function attachRealtime(httpServer) {
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: { origin: env.clientUrls, credentials: true },
    // Small payloads only; nothing large ever comes from clients.
    maxHttpBufferSize: 10_000,
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== "string" || !token) return next(unauthorized("Authentication required"));
      const payload = verifyAccessToken(token);
      const user = await User.findById(payload.sub).select("+tokenVersion role status");
      if (!user || user.status !== USER_STATUS.ACTIVE || user.tokenVersion !== payload.tv) {
        return next(unauthorized("Session is no longer valid"));
      }
      socket.data.user = { id: String(user._id), role: user.role };
      socket.data.expiresAt = payload.exp * 1000;
      next();
    } catch (error) {
      next(unauthorized(error.name === "TokenExpiredError" ? "Access token expired" : "Invalid access token"));
    }
  });

  io.on("connection", async (socket) => {
    const { id, role } = socket.data.user;
    // Register handlers first so events sent right after connecting are not missed.
    registerTracking(io, socket);
    const joined = [rooms.user(id)];
    if (role === ROLES.ADMIN) joined.push(rooms.admins);
    if (role === ROLES.RESTAURANT) {
      const restaurant = await Restaurant.findOne({ owner: id }).select("_id");
      if (restaurant) joined.push(rooms.restaurant(restaurant._id));
    }
    await socket.join(joined);

    // Drop the connection when the token runs out; the client reconnects with a fresh token.
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
