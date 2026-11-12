import * as webpush from "web-push";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { PushSubscription } from "../models/push-subscription.model.js";
import { ROLES, USER_STATUS, User } from "../models/user.model.js";
import { ApiError } from "../utils/api-error.js";
import { DAY_MS } from "../utils/dates.js";

/**
 * Web Push (browser notifications). Every in-app notification also goes out as a push to the
 * person's subscribed browsers (notification.service.js#notify calls `pushToUsers`), filtered by
 * their push preferences. Sending is best-effort and never fails the caller.
 *
 * The payload uses the Angular service worker format ({ notification: {...} }), so the browser
 * shows it and a click opens `link` in the app without any custom worker code.
 */

export const PUSH_CATEGORIES = Object.freeze(["orders", "account", "promotions"]);
const DEFAULT_PREFERENCES = Object.freeze({ orders: true, account: true, promotions: false });
const MAX_DEVICES_PER_USER = 10;
const MAX_FAILURES = 5;
const SEND_CONCURRENCY = 10;

/** Which preference switch governs a notification type. */
export function categoryOf(type = "") {
  if (type.startsWith("promo.")) return "promotions";
  if (type.startsWith("order.") || type.startsWith("payment.")) return "orders";
  return "account";
}

// ---------------------------------------------------------------------------
// Sender (swappable in tests)
// ---------------------------------------------------------------------------

let testSender = null;
let testPublicKey = null;

/**
 * Tests: replace the real Web Push call with `send(subscription, payload, options)`, which
 * resolves on success or throws an error carrying `statusCode`. Pass null to restore.
 */
export function usePushSender(send, publicKey = "test-vapid-public-key") {
  testSender = send;
  testPublicKey = send ? publicKey : null;
}

const isPushEnabled = () =>
  Boolean(testSender) || Boolean(env.push.vapidPublicKey && env.push.vapidPrivateKey);

function assertEnabled() {
  if (!isPushEnabled())
    throw new ApiError(503, "Push notifications are not available right now", {
      code: "PUSH_UNAVAILABLE",
    });
}

/** What the browser needs to subscribe. Only the public key is ever exposed. */
export const publicConfig = () => ({
  enabled: isPushEnabled(),
  publicKey: testPublicKey ?? (env.push.vapidPublicKey || null),
});

function send(subscription, payload, options) {
  if (testSender) return testSender(subscription, payload, options);
  return webpush.sendNotification(subscription, payload, {
    ...options,
    vapidDetails: {
      subject: env.push.subject,
      publicKey: env.push.vapidPublicKey,
      privateKey: env.push.vapidPrivateKey,
    },
    timeout: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * The API sends requests to the endpoint, so only https URLs on a known push service are
 * accepted (otherwise a subscription could make the server call an internal address).
 */
export function isAllowedEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return env.push.allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

// First match wins (Edge and Opera also say "Chrome", Chrome also says "Safari").
const BROWSERS = [
  [/Edg\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\//, "Firefox"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];
const SYSTEMS = [
  [/Android/, "Android"],
  [/iPhone|iPad|iPod/, "iOS"],
  [/Windows/, "Windows"],
  [/Mac OS X/, "macOS"],
  [/Linux/, "Linux"],
];
const match = (rules, ua) => rules.find(([re]) => re.test(ua))?.[1];

/** A short, non-identifying label such as "Chrome on Android". */
function deviceLabel(userAgent = "") {
  const browser = match(BROWSERS, userAgent) ?? "Browser";
  const os = match(SYSTEMS, userAgent);
  return os ? `${browser} on ${os}` : browser;
}

export async function subscribe(userId, { endpoint, keys, expirationTime }, userAgent) {
  assertEnabled();
  if (!isAllowedEndpoint(endpoint))
    throw new ApiError(422, "This browser's push service is not supported", {
      code: "PUSH_ENDPOINT_NOT_ALLOWED",
      details: [{ field: "endpoint", message: "Unsupported push service" }],
    });

  const update = {
    $set: {
      user: userId,
      keys, // validated and stripped to { p256dh, auth } by the route
      expirationTime: expirationTime ? new Date(expirationTime) : null,
      device: deviceLabel(userAgent),
      failures: 0,
    },
  };
  const upsert = () =>
    PushSubscription.findOneAndUpdate({ endpoint }, update, {
      upsert: true,
      returnDocument: "after",
      includeResultMetadata: true,
    });
  let result;
  try {
    result = await upsert();
  } catch (error) {
    // Two simultaneous first subscriptions of the same browser: the loser updates instead.
    if (error?.code !== 11000) throw error;
    result = await upsert();
  }

  // A new browser: keep only the newest few per person.
  if (result.lastErrorObject?.upserted) {
    const stale = await PushSubscription.find({ user: userId })
      .sort({ updatedAt: -1 })
      .skip(MAX_DEVICES_PER_USER)
      .select("_id")
      .lean();
    if (stale.length) await PushSubscription.deleteMany({ _id: { $in: stale.map((s) => s._id) } });
  }

  return { subscription: result.value };
}

/** Removes this browser for this person only (someone else's endpoint is left alone). */
export async function unsubscribe(userId, endpoint) {
  const { deletedCount } = await PushSubscription.deleteOne({ user: userId, endpoint });
  return { removed: deletedCount > 0 };
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

async function settingsFor(userId, user) {
  if (!user) throw ApiError.notFound("User not found");
  return {
    preferences: Object.fromEntries(
      PUSH_CATEGORIES.map((c) => [c, user.pushPreferences?.[c] ?? DEFAULT_PREFERENCES[c]]),
    ),
    // Promotions are only ever sent to customers.
    categories: user.role === ROLES.CUSTOMER ? PUSH_CATEGORIES : ["orders", "account"],
    devices: await PushSubscription.countDocuments({ user: userId }),
    enabled: isPushEnabled(),
  };
}

const PREFERENCE_FIELDS = "pushPreferences role";

export async function getPreferences(userId) {
  return settingsFor(userId, await User.findById(userId).select(PREFERENCE_FIELDS).lean());
}

export async function updatePreferences(userId, changes) {
  const $set = {};
  for (const category of PUSH_CATEGORIES)
    if (typeof changes[category] === "boolean") $set[`pushPreferences.${category}`] = changes[category];
  const user = await User.findByIdAndUpdate(userId, { $set }, { returnDocument: "after" })
    .select(PREFERENCE_FIELDS)
    .lean();
  return settingsFor(userId, user);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Only same-site paths are opened from a notification. */
const safeLink = (link) =>
  typeof link === "string" && link.startsWith("/") && !link.startsWith("//") ? link : "/";

function payloadFor({ type, title, body, link, order }) {
  const url = safeLink(link);
  return JSON.stringify({
    notification: {
      title,
      body: body || "",
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      lang: "en",
      // Later updates about the same order replace the earlier one on the device.
      tag: order ? `order-${order}` : type,
      renotify: Boolean(order),
      timestamp: Date.now(),
      data: { type, url, onActionClick: { default: { operation: "navigateLastFocusedOrOpen", url } } },
    },
  });
}

async function sendOne(sub, payload, options) {
  try {
    await send({ endpoint: sub.endpoint, keys: sub.keys }, payload, options);
    if (sub.failures || !sub.lastSuccessAt || Date.now() - sub.lastSuccessAt > DAY_MS)
      await PushSubscription.updateOne(
        { _id: sub._id },
        { $set: { lastSuccessAt: new Date(), failures: 0 } },
      );
  } catch (error) {
    const status = error?.statusCode;
    // Gone (the browser unsubscribed or it expired), or failing for too long: forget it.
    if (status === 404 || status === 410 || sub.failures + 1 >= MAX_FAILURES) {
      await PushSubscription.deleteOne({ _id: sub._id });
    } else {
      await PushSubscription.updateOne({ _id: sub._id }, { $inc: { failures: 1 } });
    }
    if (status !== 404 && status !== 410) logger.warn({ status, err: error?.message }, "Web push failed");
  }
}

async function sendAll(subscriptions, notification) {
  const urgent = categoryOf(notification.type) === "orders";
  const payload = payloadFor(notification);
  const options = {
    TTL: urgent ? 60 * 60 : 24 * 60 * 60, // an order update is useless a day later
    urgency: urgent ? "high" : "normal",
    // Collapses still-undelivered updates about the same order into the latest one.
    ...(notification.order && { topic: `o${notification.order}` }),
  };
  for (let i = 0; i < subscriptions.length; i += SEND_CONCURRENCY)
    await Promise.all(subscriptions.slice(i, i + SEND_CONCURRENCY).map((s) => sendOne(s, payload, options)));
}

const SUBSCRIPTION_FIELDS = "user endpoint keys failures lastSuccessAt";

/** Subscriptions of those users who are active and allow this category (most have none). */
async function subscriptionsFor(userIds, category) {
  const subscriptions = await PushSubscription.find({ user: { $in: userIds } })
    .select(SUBSCRIPTION_FIELDS)
    .lean();
  if (!subscriptions.length) return [];
  const allowed = await User.find({
    _id: { $in: [...new Set(subscriptions.map((s) => String(s.user)))] },
    status: USER_STATUS.ACTIVE,
    [`pushPreferences.${category}`]: DEFAULT_PREFERENCES[category] ? { $ne: false } : true,
    ...(category === "promotions" && { role: ROLES.CUSTOMER }),
  }).distinct("_id");
  const ok = new Set(allowed.map(String));
  return subscriptions.filter((s) => ok.has(String(s.user)));
}

const pending = new Set();

/** Runs `task` in the background: never throws, never delays the caller. */
function inBackground(task, type) {
  const run = task()
    .catch((error) => logger.error({ err: error, type }, "Could not send push"))
    .finally(() => pending.delete(run));
  pending.add(run);
}

/**
 * Pushes `notification` ({ type, title, body, link, order }) to the users' browsers in the
 * background. Does nothing when push is off.
 */
export function pushToUsers(userIds, notification) {
  if (!isPushEnabled()) return;
  const ids = [...new Set([userIds].flat().filter(Boolean).map(String))];
  if (!ids.length) return;
  inBackground(
    async () => sendAll(await subscriptionsFor(ids, categoryOf(notification.type)), notification),
    notification.type,
  );
}

/** Tests: waits for background pushes started so far. */
export async function flushPush() {
  while (pending.size) await Promise.allSettled([...pending]);
}

/**
 * Sends an offer to every active customer who opted in to promotional pushes and has at least
 * one subscribed browser. Returns how many people it is going to.
 */
export async function sendPromotion({ title, body, link }) {
  assertEnabled();
  const optedIn = await User.find({
    role: ROLES.CUSTOMER,
    status: USER_STATUS.ACTIVE,
    "pushPreferences.promotions": true,
  }).distinct("_id");
  const subscriptions = await PushSubscription.find({ user: { $in: optedIn } })
    .select(SUBSCRIPTION_FIELDS)
    .lean();
  const notification = { type: "promo.offer", title, body, link };
  inBackground(() => sendAll(subscriptions, notification), notification.type);
  return { recipients: new Set(subscriptions.map((s) => String(s.user))).size };
}
