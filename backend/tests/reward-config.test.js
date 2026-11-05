import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { hasPermission, PERMISSIONS } from "../config/permissions.js";
import { DEFAULT_REWARD_CONFIG } from "../config/rewards.js";
import { RewardConfiguration } from "../models/reward-configuration.model.js";
import {
  coinsToPaise,
  expiryFor,
  getRewardConfig,
  restoredExpiry,
  updateRewardConfig,
} from "../services/reward-config.service.js";
import { resetDb, setupTestDb, teardownTestDb } from "./helpers.js";

const admin = { _id: new mongoose.Types.ObjectId(), role: "admin" };
const code = (expected) => (error) => {
  assert.equal(error.code, expected, error.message);
  return true;
};

describe("reward configuration", () => {
  before(setupTestDb);
  after(teardownTestDb);
  beforeEach(resetDb);

  it("reads the defaults when nothing is stored", async () => {
    const config = await getRewardConfig();
    assert.equal(config.version, 0);
    assert.equal(config.coinsEnabled, true);
    assert.deepEqual(config.earning, DEFAULT_REWARD_CONFIG.earning);
    assert.deepEqual(config.redemption, DEFAULT_REWARD_CONFIG.redemption);
    assert.deepEqual(config.expiry, DEFAULT_REWARD_CONFIG.expiry);
    assert.equal(await RewardConfiguration.countDocuments(), 0);
  });

  it("saves a partial change, keeps the other values and bumps the version", async () => {
    const saved = await updateRewardConfig(
      admin,
      { redemption: { minCoins: 50, paymentMethods: ["online"] }, birthday: { coins: 150 } },
      0,
    );
    assert.equal(saved.version, 1);
    assert.equal(saved.redemption.minCoins, 50);
    assert.deepEqual(saved.redemption.paymentMethods, ["online"]);
    assert.equal(saved.redemption.maxCoinsPerOrder, DEFAULT_REWARD_CONFIG.redemption.maxCoinsPerOrder);
    assert.equal(saved.birthday.coins, 150);
    assert.equal(saved.updatedBy, String(admin._id));
    assert.equal((await getRewardConfig()).birthday.coins, 150);
  });

  it("refuses to overwrite a newer version", async () => {
    await updateRewardConfig(admin, { birthday: { coins: 120 } }, 0);
    await assert.rejects(updateRewardConfig(admin, { birthday: { coins: 130 } }, 0), code("CONFIG_CHANGED"));
    assert.equal((await getRewardConfig()).birthday.coins, 120);
  });

  it("only lets one of two simultaneous first saves win", async () => {
    const results = await Promise.allSettled([
      updateRewardConfig(admin, { birthday: { coins: 101 } }, 0),
      updateRewardConfig(admin, { birthday: { coins: 102 } }, 0),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(await RewardConfiguration.countDocuments(), 1);
  });

  it("validates values and ranges", async () => {
    for (const patch of [
      { redemption: { minCoins: 5000, maxCoinsPerOrder: 100 } },
      { redemption: { maxPercentOfOrder: 150 } },
      { earning: { order: { coinsPerUnit: 2.5 } } },
      { earning: { review: { coins: -1 } } },
      { expiry: { days: { ORDER_REWARD: 99999 } } },
      { redemption: { paymentMethods: ["wallet"] } },
      { timezone: "Mars/Olympus" },
      { welcome: { trigger: "sometimes" } },
      { birthday: { coins: "lots" } },
    ]) {
      await assert.rejects(updateRewardConfig(admin, patch), code("VALIDATION_ERROR"), JSON.stringify(patch));
    }
    assert.equal(await RewardConfiguration.countDocuments(), 0);
  });

  it("ignores unknown and protected fields", async () => {
    const saved = await updateRewardConfig(admin, {
      somethingElse: true,
      key: "other",
      version: 99,
      redemption: { secret: 1, minCoins: 120 },
    });
    assert.equal(saved.redemption.minCoins, 120);
    assert.ok(!("somethingElse" in saved));
    assert.equal((await RewardConfiguration.findOne()).key, "global");
  });

  it("converts coins to paise and works out expiry dates", async () => {
    const config = await getRewardConfig();
    assert.equal(coinsToPaise(100, config), 1000); // 100 coins = ₹10
    assert.equal(coinsToPaise(15, config), 150);
    assert.equal(coinsToPaise(1, { redemption: { coinValueCoins: 3, coinValuePaise: 100 } }), 33);

    const now = new Date("2026-11-05T00:00:00Z");
    assert.equal(expiryFor("ORDER_REWARD", config, now).toISOString(), "2027-05-04T00:00:00.000Z");
    assert.equal(expiryFor("ORDER_REWARD", { expiry: { enabled: false } }, now), null);
    assert.equal(expiryFor("ORDER_REWARD", { expiry: { enabled: true, days: { ORDER_REWARD: 0 } } }, now), null);

    const soon = new Date("2026-11-06T00:00:00Z");
    assert.equal(restoredExpiry(soon, config, now).toISOString(), "2026-11-12T00:00:00.000Z");
    const later = new Date("2027-01-01T00:00:00Z");
    assert.equal(restoredExpiry(later, config, now), later);
    assert.equal(restoredExpiry(null, config, now), null);
  });

  it("gives reward management to the super admin only", () => {
    assert.ok(hasPermission("admin", PERMISSIONS.REWARDS_MANAGE));
    assert.ok(hasPermission("admin", PERMISSIONS.REWARDS_VIEW));
    for (const role of ["operations_admin", "finance_admin", "support_admin", "customer"])
      assert.ok(!hasPermission(role, PERMISSIONS.REWARDS_MANAGE), role);
  });
});
