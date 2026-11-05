import { logger } from "../config/logger.js";

/**
 * Runs `sweep()` every `intervalMs`, never two at once. Logs the summary when `hasWork(summary)`.
 * Returns a stop function (used on shutdown).
 */
export function startSweepLoop(name, sweep, intervalMs, hasWork) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const summary = await sweep();
      if (hasWork(summary)) logger.info(summary, `${name} sweep`);
    } catch (error) {
      logger.error({ err: error }, `${name} sweep failed`);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
