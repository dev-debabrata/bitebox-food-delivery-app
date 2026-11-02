import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { ApiError } from "../utils/api-error.js";
import { haversineMeters } from "../utils/geo.js";

/**
 * Road routes between two points: distance, estimated travel time and the
 * line to draw on the map.
 *
 * The provider sits behind `providers` so it can be swapped (self-hosted OSRM,
 * GraphHopper, a commercial API) without touching callers. The default is the
 * public OSRM demo server, which is meant for light use only: requests are
 * cached, serialised at most ~1 per second and time out quickly. Callers should
 * treat a failure (503 ROUTING_UNAVAILABLE) as "show a straight line instead".
 *
 * Results are estimates. They are not live traffic and not the rider's actual progress.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 2000;
const MIN_GAP_MS = 1100;
const MAX_ROUTE_KM = 100; // deliveries are local; anything longer is a bad request
const cache = new Map();
let queue = Promise.resolve();
let lastRequestAt = 0;

/** OSRM: GET /route/v1/{profile}/{lng,lat};{lng,lat}?overview=simplified&geometries=geojson */
const osrm = {
  name: "osrm",
  attribution: "Routes © OSRM, map data © OpenStreetMap contributors",
  async route(from, to) {
    const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
    const url = new URL(`/route/v1/${env.routing.profile}/${coords}`, env.routing.url);
    url.searchParams.set("overview", "simplified");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("alternatives", "false");
    url.searchParams.set("steps", "false");
    const res = await fetch(url, { headers: { "User-Agent": env.routing.userAgent }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`Routing HTTP ${res.status}`);
    const body = await res.json();
    const best = body.routes?.[0];
    if (body.code !== "Ok" || !best) throw new Error(`Routing returned ${body.code ?? "no route"}`);
    return {
      distanceMeters: Math.round(best.distance),
      durationSeconds: Math.round(best.duration),
      // GeoJSON is [lng, lat]; the app uses { latitude, longitude }.
      path: best.geometry.coordinates.map(([longitude, latitude]) => ({ latitude, longitude })),
    };
  },
};

export const providers = { osrm };
let provider = osrm;

/** For tests: swap the provider (e.g. a fake). Returns a function that restores the previous one. */
export function useProvider(next) {
  const previous = provider;
  provider = next;
  cache.clear();
  return () => {
    provider = previous;
    cache.clear();
  };
}

// ~11 m: points closer than this share a cached route.
const keyOf = (p) => `${p.latitude.toFixed(4)},${p.longitude.toFixed(4)}`;

function throttled(task) {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0 && !env.isTest) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return task();
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Road route from `from` to `to` ({ latitude, longitude }).
 * Also returns the straight-line distance so the UI can label both honestly.
 */
export async function route(from, to) {
  const straightLineMeters = haversineMeters([from.longitude, from.latitude], [to.longitude, to.latitude]);
  if (straightLineMeters > MAX_ROUTE_KM * 1000) throw ApiError.badRequest(`Routes are limited to ${MAX_ROUTE_KM} km`);

  const key = `${provider.name}|${keyOf(from)}|${keyOf(to)}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let result;
  try {
    result = await throttled(() => provider.route(from, to));
  } catch (error) {
    logger.warn({ err: error }, "Routing request failed");
    throw new ApiError(503, "Road routing is unavailable right now", { code: "ROUTING_UNAVAILABLE" });
  }
  const value = { ...result, straightLineMeters, provider: provider.name, attribution: provider.attribution, estimate: true };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}
