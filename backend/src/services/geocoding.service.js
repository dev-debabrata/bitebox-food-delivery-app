import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { ApiError } from "../utils/api-error.js";

/**
 * Place search ("Topsia, Kolkata" -> coordinates) and reverse geocoding
 * (coordinates -> "Topsia, Kolkata").
 *
 * Default provider: OpenStreetMap Nominatim. Its public server allows at most
 * 1 request/second, requires an identifying User-Agent, and expects caching
 * (https://operations.osmfoundation.org/policies/nominatim/). So all requests
 * go through the backend, are serialised with a minimum gap, and cached.
 * For production traffic, point GEOCODER_URL at a self-hosted Nominatim or a
 * commercial provider and swap `provider` below.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 1000;
const MIN_GAP_MS = 1100;
const cache = new Map();
let queue = Promise.resolve();
let lastRequestAt = 0;

function cached(key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  cache.delete(key);
  return undefined;
}

function remember(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Serialises upstream calls so we never exceed the provider's rate limit. */
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

async function fetchJson(path, params) {
  const url = new URL(path, env.geocoder.url);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": env.geocoder.userAgent, "Accept-Language": "en" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`Geocoder HTTP ${res.status}`);
    return await res.json();
  } catch (error) {
    logger.warn({ err: error, path }, "Geocoding request failed");
    throw new ApiError(503, "Location search is unavailable right now. Please try again.", { code: "GEOCODER_UNAVAILABLE" });
  }
}

/** Short human label from Nominatim address parts, e.g. "Topsia, Kolkata". */
function toPlace(item) {
  const a = item.address ?? {};
  const area = a.neighbourhood ?? a.suburb ?? a.quarter ?? a.road ?? a.village ?? a.hamlet;
  const city = a.city ?? a.town ?? a.municipality ?? a.city_district ?? a.county ?? a.state_district;
  const label = [area, city].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(", ") || item.display_name?.split(",").slice(0, 2).join(",").trim();
  return {
    label,
    displayName: item.display_name,
    latitude: Number(item.lat),
    longitude: Number(item.lon),
    area: area ?? null,
    city: city ?? null,
    state: a.state ?? null,
    postalCode: a.postcode ?? null,
  };
}

const provider = {
  search: (query) =>
    fetchJson("/search", {
      format: "jsonv2",
      q: query,
      limit: 6,
      addressdetails: 1,
      countrycodes: env.geocoder.countryCodes,
    }),
  reverse: (latitude, longitude) =>
    fetchJson("/reverse", { format: "jsonv2", lat: latitude, lon: longitude, zoom: 16, addressdetails: 1 }),
};

export async function search(query) {
  const key = `s:${query.trim().toLowerCase()}`;
  const hit = cached(key);
  if (hit) return hit;
  const results = await throttled(() => provider.search(query.trim()));
  return remember(key, (Array.isArray(results) ? results : []).map(toPlace));
}

export async function reverse(latitude, longitude) {
  // ~110 m grid so nearby lookups share a cache entry.
  const key = `r:${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const hit = cached(key);
  if (hit) return hit;
  const result = await throttled(() => provider.reverse(latitude, longitude));
  if (!result || result.error) throw ApiError.notFound("No address found for this location");
  return remember(key, { ...toPlace(result), latitude, longitude });
}

/** Test helper. */
export const clearGeocodingCache = () => cache.clear();
