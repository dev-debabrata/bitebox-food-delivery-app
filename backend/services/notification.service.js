import { logger } from "../config/logger.js";
import { Notification } from "../models/notification.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { hasPermission } from "../config/permissions.js";
import { ADMIN_ROLES, ROLES, USER_STATUS, User } from "../models/user.model.js";
import { emitToUsers } from "../sockets/events.js";
import { CHANNELS, DELIVERY_STATUS, NotificationDelivery } from "../models/notification-delivery.model.js";
import { DeviceToken } from "../models/device-token.model.js";
import { PushSubscription } from "../models/push-subscription.model.js";
import { startSweepLoop } from "../utils/sweep-loop.js";
import { PermanentFailure, Skip, categoryOf, channelEnabled, channelsFor, senderFor } from "./notification-channels.js";
import {
  DEFAULT_PREFERENCES,
  PUSH_CATEGORIES,
  isPushEnabled,
  runInBackground,
} from "./push.service.js";
import { ApiError } from "../utils/api-error.js";
import { paginationMeta } from "../utils/pagination.js";

/**
 * Stores one inbox row per user (the in-app channel, always on), then one delivery per external
 * channel the type uses, the person allows and can be reached on (Web Push, FCM, email, SMS).
 * Deliveries are attempted in the background; failures are retried with back-off by the
 * notification loop and become dead letters after MAX_ATTEMPTS. Never fails the caller.
 */
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
    const deliveries = await NotificationDelivery.insertMany(await plan(docs));
    for (const d of deliveries) runInBackground(() => attempt(d._id), type);
  } catch (error) {
    logger.error({ err: error, type }, "Could not store notification");
  }
}

/** The external deliveries for these inbox rows (all of one type). */
async function plan(docs) {
  const { type } = docs[0];
  const category = categoryOf(type);
  const wanted = channelsFor(type).filter(channelEnabled);
  if (!wanted.length) return [];
  const ids = docs.map((d) => d.user);
  const [users, withBrowser, withApp] = await Promise.all([
    User.find({ _id: { $in: ids }, status: USER_STATUS.ACTIVE })
      .select("role email phone pushPreferences channelPreferences")
      .lean(),
    PushSubscription.distinct("user", { user: { $in: ids } }),
    DeviceToken.distinct("user", { user: { $in: ids } }),
  ]);
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const browser = new Set(withBrowser.map(String));
  const app = new Set(withApp.map(String));
  const reachable = {
    push: (u) => browser.has(String(u._id)),
    fcm: (u) => app.has(String(u._id)),
    email: (u) => Boolean(u.email),
    sms: (u) => Boolean(u.phone),
  };
  return docs.flatMap((doc) => {
    const user = byId.get(String(doc.user));
    if (!user || (category === "promotions" && user.role !== ROLES.CUSTOMER)) return [];
    return wanted
      .filter((channel) => allows(user, channel, category) && reachable[channel](user))
      .map((channel) => ({ notification: doc._id, user: doc.user, channel }));
  });
}

// Email follows the push defaults; SMS (costly) is opt-in.
const PREFERENCE_DEFAULTS = {
  push: DEFAULT_PREFERENCES,
  email: DEFAULT_PREFERENCES,
  sms: { orders: false, account: false, promotions: false },
};
const switchOf = (user, channel, category) => {
  const value =
    channel === "push"
      ? user.pushPreferences?.[category]
      : user.channelPreferences?.[channel]?.[category];
  return value ?? PREFERENCE_DEFAULTS[channel][category];
};
const allows = (user, channel, category) =>
  switchOf(user, channel === CHANNELS.FCM ? "push" : channel, category);

// Delivery attempts ------------------------------------------------------------------------------

export const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const LEASE_MS = 5 * 60_000; // a claimed delivery is not picked up again meanwhile
const D = DELIVERY_STATUS;

/** One try at one delivery. Resolves to its new status (null when not due or not found). */
export async function attempt(deliveryId, now = new Date()) {
  const delivery = await NotificationDelivery.findOneAndUpdate(
    {
      _id: deliveryId,
      status: { $in: [D.QUEUED, D.FAILED] },
      $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
    },
    { $set: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) } },
    { returnDocument: "after" },
  );
  if (!delivery) return null; // sent, dead, or another worker has it
  const [notification, user] = await Promise.all([
    Notification.findById(delivery.notification).lean(),
    User.findById(delivery.user).select("name email phone").lean(),
  ]);
  const attempts = delivery.attempts + 1;
  let set;
  try {
    if (!notification || !user) throw new Skip("Notification or person gone");
    if (!channelEnabled(delivery.channel)) throw new Skip(`${delivery.channel} is off`);
    await senderFor(delivery.channel)(notification, user);
    set = { status: D.SENT, sentAt: new Date(), lastError: null, nextAttemptAt: null };
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 500);
    if (error instanceof Skip) set = { status: D.SKIPPED, lastError: message, nextAttemptAt: null };
    else if (error instanceof PermanentFailure || attempts >= MAX_ATTEMPTS) {
      set = { status: D.DEAD, lastError: message, nextAttemptAt: null };
      logger.error({ delivery: String(delivery._id), err: message }, "Notification dead letter");
    } else {
      const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1];
      set = { status: D.FAILED, lastError: message, nextAttemptAt: new Date(now.getTime() + wait) };
    }
  }
  await NotificationDelivery.updateOne({ _id: delivery._id }, { $set: { ...set, attempts } });
  return set.status;
}

/** Retries failed deliveries whose wait is over, and queued ones nobody picked up. */
export async function retryDue(now = new Date()) {
  const due = await NotificationDelivery.find({
    $or: [
      { status: D.FAILED, nextAttemptAt: { $lte: now } },
      { status: D.QUEUED, nextAttemptAt: null, createdAt: { $lte: new Date(now - 2 * 60_000) } },
      { status: D.QUEUED, nextAttemptAt: { $lte: now } }, // a run died holding the lease
    ],
  })
    .select("_id")
    .limit(500)
    .lean();
  for (const { _id } of due) await attempt(_id, now);
  return { retried: due.length };
}

/** Runs `retryDue` every minute; returns a stop function (used on shutdown). */
export const startNotificationLoop = (intervalMs = 60_000) =>
  startSweepLoop("Notifications", () => retryDue(), intervalMs, (s) => s.retried > 0);

/**
 * Every active admin whose role has `permission` gets the notification (the super admin always
 * does), e.g. operations admins for a restaurant waiting for review.
 */
export async function notifyAdmins(payload, permission) {
  const roles = ADMIN_ROLES.filter(
    (role) => role === ROLES.ADMIN || hasPermission(role, permission),
  );
  const admins = await User.find({
    role: { $in: roles },
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

// Preferences ------------------------------------------------------------------------------------

/** Every channel's switches per category, and which channels are available to this person. */
export async function channelPreferences(userId) {
  const user = await User.findById(userId).select("role email phone pushPreferences channelPreferences").lean();
  if (!user) throw ApiError.notFound("User not found");
  const switches = (channel) => Object.fromEntries(PUSH_CATEGORIES.map((c) => [c, switchOf(user, channel, c)]));
  return {
    channels: { push: switches("push"), email: switches("email"), sms: switches("sms") },
    // Promotions are only ever sent to customers.
    categories: user.role === ROLES.CUSTOMER ? PUSH_CATEGORIES : ["orders", "account"],
    available: {
      push: isPushEnabled(),
      email: channelEnabled(CHANNELS.EMAIL) && Boolean(user.email),
      sms: channelEnabled(CHANNELS.SMS) && Boolean(user.phone),
    },
  };
}

export async function updateChannelPreferences(userId, changes) {
  const $set = {};
  for (const channel of ["push", "email", "sms"])
    for (const c of PUSH_CATEGORIES)
      if (typeof changes[channel]?.[c] === "boolean")
        $set[channel === "push" ? `pushPreferences.${c}` : `channelPreferences.${channel}.${c}`] =
          changes[channel][c];
  if (Object.keys($set).length) await User.updateOne({ _id: userId }, { $set });
  return channelPreferences(userId);
}

// FCM device tokens (future native apps) --------------------------------------------------------

const MAX_DEVICES_PER_USER = 10;

export async function registerDevice(userId, { token, platform }) {
  const device = await DeviceToken.findOneAndUpdate(
    { token },
    { $set: { user: userId, platform, failures: 0 } },
    { upsert: true, returnDocument: "after" },
  );
  const stale = await DeviceToken.find({ user: userId })
    .sort({ updatedAt: -1 })
    .skip(MAX_DEVICES_PER_USER)
    .select("_id")
    .lean();
  if (stale.length) await DeviceToken.deleteMany({ _id: { $in: stale.map((d) => d._id) } });
  return { device: { id: String(device._id), platform: device.platform } };
}

export async function unregisterDevice(userId, token) {
  const { deletedCount } = await DeviceToken.deleteOne({ user: userId, token });
  return { removed: deletedCount > 0 };
}

// Admin: delivery log and dead letters ----------------------------------------------------------

function deliveryJson(d) {
  return {
    id: String(d._id),
    channel: d.channel,
    status: d.status,
    attempts: d.attempts,
    lastError: d.lastError ?? null,
    nextAttemptAt: d.nextAttemptAt ?? null,
    sentAt: d.sentAt ?? null,
    createdAt: d.createdAt,
    notification: d.notification
      ? { id: String(d.notification._id), type: d.notification.type, title: d.notification.title }
      : null,
    user: d.user ? { id: String(d.user._id), name: d.user.name, email: d.user.email } : null,
  };
}

const populated = (query) =>
  query.populate("notification", "type title").populate("user", "name email").lean();

export async function adminDeliveries({ status, channel }, pagination) {
  const filter = { ...(status && { status }), ...(channel && { channel }) };
  const [items, total, counts] = await Promise.all([
    populated(
      NotificationDelivery.find(filter).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit),
    ),
    NotificationDelivery.countDocuments(filter),
    NotificationDelivery.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  return {
    items: items.map(deliveryJson),
    pagination: paginationMeta(pagination, total),
    counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
  };
}

/** Sends a dead (or failed) delivery again now. */
export async function adminRetry(id) {
  const delivery = await NotificationDelivery.findOneAndUpdate(
    { _id: id, status: { $in: [D.DEAD, D.FAILED] } },
    { $set: { status: D.QUEUED, nextAttemptAt: null, lastError: null } },
  );
  if (!delivery) {
    if (!(await NotificationDelivery.exists({ _id: id }))) throw ApiError.notFound("Delivery not found");
    throw ApiError.conflict("Only failed or dead deliveries can be retried", "NOT_RETRYABLE");
  }
  await attempt(id);
  return { delivery: deliveryJson(await populated(NotificationDelivery.findById(id))) };
}
