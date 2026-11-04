import { env } from "../config/env.js";

export function createUpstream({ ttlMs, maxEntries, minGapMs }) {
  const cache = new Map();
  const inFlight = new Map();
  let queue = Promise.resolve();
  let lastRequestAt = 0;

  function throttled(task) {
    const run = queue.then(async () => {
      const wait = lastRequestAt + minGapMs - Date.now();
      if (wait > 0 && !env.isTest)
        await new Promise((r) => setTimeout(r, wait));
      lastRequestAt = Date.now();
      return task();
    });
    queue = run.catch(() => undefined);
    return run;
  }

  function get(key, load) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = throttled(load)
      .then((value) => {
        if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
        cache.set(key, { value, expires: Date.now() + ttlMs });
        return value;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  }

  return { get, clear: () => cache.clear() };
}
