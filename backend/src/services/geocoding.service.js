import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { ApiError } from "../utils/api-error.js";
import { createUpstream } from "../utils/upstream.js";

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

// Nominatim's public policy: at most 1 request/second, and cache what you can.
const upstream = createUpstream({ ttlMs: 24 * 60 * 60 * 1000, maxEntries: 1000, minGapMs: 1100 });

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

export function search(query) {
  return upstream.get(`s:${query.trim().toLowerCase()}`, async () => {
    const results = await provider.search(query.trim());
    return (Array.isArray(results) ? results : []).map(toPlace);
  });
}

export function reverse(latitude, longitude) {
  // ~110 m grid so nearby lookups share a cache entry.
  return upstream.get(`r:${latitude.toFixed(3)},${longitude.toFixed(3)}`, async () => {
    const result = await provider.reverse(latitude, longitude);
    if (!result || result.error) throw ApiError.notFound("No address found for this location");
    return { ...toPlace(result), latitude, longitude };
  });
}

/** Test helper. */
export const clearGeocodingCache = () => upstream.clear();
