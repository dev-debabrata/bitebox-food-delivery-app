import { logger } from "../config/logger.js";
import { Notification } from "../models/notification.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { ROLES, USER_STATUS, User } from "../models/user.model.js";
import { emitToUsers } from "../sockets/events.js";
import { ApiError } from "../utils/api-error.js";
import { paginationMeta } from "../utils/pagination.js";

export async function notify(userIds, { type, title, body, link, order }) {
  const users = [
    ...new Set(
      (Array.isArray(userIds) ? userIds : [userIds])
        .filter(Boolean)
        .map(String),
    ),
  ];
  if (!users.length) return;
  try {
    const docs = await Notification.insertMany(
      users.map((user) => ({ user, type, title, body, link, order })),
    );
    for (const doc of docs)
      emitToUsers([doc.user], "notification:new", doc.toJSON());
  } catch (error) {
    logger.error({ err: error, type }, "Could not store notification");
  }
}

/** Every active admin gets the notification (e.g. a restaurant waiting for review). */
export async function notifyAdmins(payload) {
  const admins = await User.find({
    role: ROLES.ADMIN,
    status: USER_STATUS.ACTIVE,
  }).select("_id");
  await notify(
    admins.map((a) => a._id),
    payload,
  );
}

/** The owner (User id) of a restaurant, for restaurant-facing notifications. */
export async function restaurantOwner(restaurantId) {
  return (
    (await Restaurant.findById(restaurantId).select("owner"))?.owner ?? null
  );
}

/** Newest first; `unreadOnly` for the "Unread" tab. `unread` is always the full unread count. */
export async function list(userId, pagination, { unreadOnly = false } = {}) {
  const filter = { user: userId, ...(unreadOnly && { readAt: null }) };
  const [items, total, unread] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ user: userId, readAt: null }),
  ]);
  return { items, unread, pagination: paginationMeta(pagination, total) };
}

export async function markRead(userId, id) {
  const doc = await Notification.findOneAndUpdate(
    { _id: id, user: userId },
    { $set: { readAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!doc) throw ApiError.notFound("Notification not found");
  return doc;
}

export async function markAllRead(userId) {
  const { modifiedCount } = await Notification.updateMany(
    { user: userId, readAt: null },
    { $set: { readAt: new Date() } },
  );
  return { updated: modifiedCount };
}

/** "Clear all": deletes every notification of this user. */
export async function clearAll(userId) {
  const { deletedCount } = await Notification.deleteMany({ user: userId });
  return { deleted: deletedCount };
}
