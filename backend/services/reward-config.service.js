import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { RewardConfiguration } from "../models/reward-configuration.model.js";
import { ApiError } from "../utils/api-error.js";
import { DAY_MS } from "../utils/dates.js";

const KEY = "global";
// Each API instance re-reads the settings at most this often; an update clears it at once locally.
const CACHE_MS = env.isTest ? 0 : 30_000;

let cache = null; // { value, at }

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

/** {a: {b: 1}} -> {"a.b": 1}. Arrays are set whole. */
function flatten(value, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) flatten(v, path, out);
    else out[path] = v;
  }
  return out;
}

/** The settings as plain data, plus `version` (send it back when saving) and who saved them last. */
function present(doc) {
  const json = doc.toObject({ versionKey: true, minimize: false });
  const { _id, __v, key, createdAt, revision, ...settings } = json;
  void _id;
  void __v;
  void key;
  void createdAt;
  return {
    ...settings,
    updatedBy: settings.updatedBy ? String(settings.updatedBy) : null,
    version: revision ?? 0,
  };
}

const load = async () =>
  (await RewardConfiguration.findOne({ key: KEY })) ??
  new RewardConfiguration({ key: KEY });

/** The current reward configuration (defaults merged in). Cached briefly. */
export async function getRewardConfig({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = Object.freeze(present(await load()));
  cache = { value, at: Date.now() };
  return value;
}

const resetRewardConfigCache = () => {
  cache = null;
};

/**
 * Saves a partial change (nested objects are merged, arrays replaced). Pass the `version` you
 * read to refuse saving over someone else's newer change. Unknown fields are ignored.
 */
export async function updateRewardConfig(user, patch, expectedVersion) {
  const doc = await load();
  if (expectedVersion !== undefined && expectedVersion !== (doc.revision ?? 0)) {
    throw new ApiError(
      409,
      "The reward settings were changed by someone else. Reload them and try again.",
      { code: "CONFIG_CHANGED" },
    );
  }
  const changes = flatten(patch ?? {});
  for (const path of Object.keys(changes)) {
    // Only real settings: no ids, versions, timestamps or unknown paths.
    if (
      ["key", "_id", "__v", "version", "revision", "createdAt", "updatedAt", "updatedBy"].includes(
        path.split(".")[0],
      ) ||
      !RewardConfiguration.schema.path(path)
    ) {
      delete changes[path];
    }
  }
  for (const [path, value] of Object.entries(changes)) doc.set(path, value);
  doc.updatedBy = user?._id ?? null;
  doc.revision = (doc.revision ?? 0) + 1;
  try {
    await doc.save();
  } catch (error) {
    if (error instanceof mongoose.Error.ValidationError) {
      throw new ApiError(422, "Validation failed", {
        code: "VALIDATION_ERROR",
        details: Object.values(error.errors).map((e) => ({
          field: e.path,
          message: e.message,
        })),
      });
    }
    // Someone saved first (version bump) or created the document at the same moment.
    if (error instanceof mongoose.Error.VersionError || error?.code === 11000) {
      throw new ApiError(
        409,
        "The reward settings were changed by someone else. Reload them and try again.",
        { code: "CONFIG_CHANGED" },
      );
    }
    throw error;
  }
  resetRewardConfigCache();
  logger.info(
    { by: user?._id ? String(user._id) : null, fields: Object.keys(changes) },
    "Reward configuration updated",
  );
  return getRewardConfig({ fresh: true });
}

// ---------------------------------------------------------------------------
// Pure helpers over a configuration value
// ---------------------------------------------------------------------------

/** Rupee value of a number of coins, in paise (rounded down). 100 coins = 1000 paise by default. */
export function coinsToPaise(coins, config) {
  const { coinValueCoins, coinValuePaise } = config.redemption;
  return Math.floor((coins * coinValuePaise) / coinValueCoins);
}

/** When coins earned now from `source` expire (null = never). */
export function expiryFor(source, config, now = new Date()) {
  if (!config.expiry.enabled) return null;
  const days = config.expiry.days?.[source] ?? 0;
  return days > 0 ? new Date(now.getTime() + days * DAY_MS) : null;
}

/** The earliest expiry for coins given back to a customer (cancelled order). */
export function restoredExpiry(originalExpiresAt, config, now = new Date()) {
  if (!originalExpiresAt) return null;
  const floor = new Date(now.getTime() + config.expiry.restoreGraceDays * DAY_MS);
  return originalExpiresAt > floor ? originalExpiresAt : floor;
}
