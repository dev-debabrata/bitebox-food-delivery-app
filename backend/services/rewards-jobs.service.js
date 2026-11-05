import { logger } from "../config/logger.js";
import { startSweepLoop } from "../utils/sweep-loop.js";
import { REWARDS_JOBS } from "../config/rewards.js";
import { expireDueCoins, settlePendingRows } from "./coin-wallet.service.js";
import { settleStaleReservations } from "./coins.service.js";
import { referralSweep } from "./referral.service.js";
import { birthdaySweep, campaignSweep } from "./special-rewards.service.js";

/**
 * Scheduled rewards work. Every step is bounded, idempotent and safe to run on several API
 * instances at once (ledger idempotency keys and conditional updates decide who does the work).
 * Tests call rewardsSweep(now) directly.
 */
const STEPS = [
  ["pendingLedgerRows", ({ now, limit }) => settlePendingRows({ now, limit })],
  ["coinHolds", ({ limit }) => settleStaleReservations({ limit })],
  ["expiredCoins", ({ now, limit }) => expireDueCoins({ now, limit })],
  ["referrals", ({ now, limit }) => referralSweep({ now, limit })],
  ["campaigns", ({ now, limit }) => campaignSweep({ now, limit })],
  ["birthdays", ({ now, limit }) => birthdaySweep({ now, limit })],
];

export async function rewardsSweep(now = new Date(), { limit = REWARDS_JOBS.batchSize } = {}) {
  const summary = {};
  for (const [name, run] of STEPS) {
    try {
      summary[name] = await run({ now, limit });
    } catch (err) {
      summary[name] = { error: err.message };
      logger.error({ err, step: name }, "Rewards sweep step failed");
    }
  }
  return summary;
}

const hasWork = (value) =>
  typeof value === "number"
    ? value > 0
    : value && typeof value === "object" && Object.values(value).some(hasWork);

export const startRewardsLoop = (intervalMs = REWARDS_JOBS.sweepIntervalMs) =>
  startSweepLoop("Rewards", () => rewardsSweep(), intervalMs, hasWork);
