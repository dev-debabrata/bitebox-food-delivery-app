import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { ApiError } from "../utils/api-error.js";
import { haversineMeters } from "../utils/geo.js";
import { createUpstream } from "../utils/upstream.js";

const MAX_ROUTE_KM = 100; // deliveries are local; anything longer is a bad request
// The public OSRM demo server: light use only, so cache and space out requests.
const upstream = createUpstream({
  ttlMs: 10 * 60 * 1000,
  maxEntries: 2000,
  minGapMs: 1100,
});

/** OSRM: GET /route/v1/{profile}/{lng,lat};{lng,lat}?overview=simplified&geometries=geojson */
const osrm = {
  name: "osrm",
  attribution: "Routes © OSRM, map data © OpenStreetMap contributors",
  async route(from, to) {
    const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
    const url = new URL(
      `/route/v1/${env.routing.profile}/${coords}`,
      env.routing.url,
    );
    url.searchParams.set("overview", "simplified");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("alternatives", "false");
    url.searchParams.set("steps", "false");
    const res = await fetch(url, {
      headers: { "User-Agent": env.routing.userAgent },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`Routing HTTP ${res.status}`);
    const body = await res.json();
    const best = body.routes?.[0];
    if (body.code !== "Ok" || !best)
      throw new Error(`Routing returned ${body.code ?? "no route"}`);
    return {
      distanceMeters: Math.round(best.distance),
      durationSeconds: Math.round(best.duration),
      // GeoJSON is [lng, lat]; the app uses { latitude, longitude }.
      path: best.geometry.coordinates.map(([longitude, latitude]) => ({
        latitude,
        longitude,
      })),
    };
  },
};

let provider = osrm;

/** For tests: swap the provider (e.g. a fake). Returns a function that restores the previous one. */
export function useProvider(next) {
  const previous = provider;
  provider = next;
  upstream.clear();
  return () => {
    provider = previous;
    upstream.clear();
  };
}

// ~11 m: points closer than this share a cached route.
const keyOf = (p) => `${p.latitude.toFixed(4)},${p.longitude.toFixed(4)}`;

export async function route(from, to) {
  const straightLineMeters = haversineMeters(
    [from.longitude, from.latitude],
    [to.longitude, to.latitude],
  );
  if (straightLineMeters > MAX_ROUTE_KM * 1000)
    throw ApiError.badRequest(`Routes are limited to ${MAX_ROUTE_KM} km`);

  const { name, attribution } = provider;
  try {
    return await upstream.get(
      `${name}|${keyOf(from)}|${keyOf(to)}`,
      async () => ({
        ...(await provider.route(from, to)),
        straightLineMeters,
        provider: name,
        attribution,
        estimate: true,
      }),
    );
  } catch (error) {
    logger.warn({ err: error }, "Routing request failed");
    throw new ApiError(503, "Road routing is unavailable right now", {
      code: "ROUTING_UNAVAILABLE",
    });
  }
}
