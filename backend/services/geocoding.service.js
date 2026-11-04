import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { ApiError } from "../utils/api-error.js";
import { createUpstream } from "../utils/upstream.js";

const upstream = createUpstream({
  ttlMs: 24 * 60 * 60 * 1000,
  maxEntries: 1000,
  minGapMs: 1100,
});

async function fetchJson(target, params = {}, headers = {}) {
  const url = target.startsWith("http")
    ? new URL(target)
    : new URL(target, env.geocoder.url);
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Geocoder HTTP ${res.status}`);
  return res.json();
}

function makePlace({
  label,
  displayName,
  latitude,
  longitude,
  area,
  city,
  state,
  postalCode,
  street,
  building,
}) {
  const place = {
    label: label || "Pinned location",
    displayName: displayName || label || "Pinned location",
    latitude: Number(latitude),
    longitude: Number(longitude),
    area: area ?? null,
    city: city ?? null,
    state: state ?? null,
    postalCode: postalCode ?? null,
  };
  if (street) place.street = street;
  if (building) place.building = building;
  return place;
}

function toPlace(item) {
  const a = item.address ?? {};
  const street =
    a.road ?? a.pedestrian ?? a.street ?? a.residential ?? a.footway ?? a.path;
  const building =
    a.building ??
    a.house_number ??
    a.house_name ??
    a.commercial ??
    a.industrial ??
    a.amenity;
  const suburb =
    a.suburb ??
    a.neighbourhood ??
    a.quarter ??
    a.district ??
    a.village ??
    a.hamlet;
  const area = suburb ?? street ?? a.subdivision;
  const city =
    a.city ??
    a.town ??
    a.municipality ??
    a.city_district ??
    a.county ??
    a.state_district;
  const label =
    [area, city]
      .filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .join(", ") ||
    item.display_name?.split(",").slice(0, 2).join(",").trim() ||
    item.name;
  return makePlace({
    label,
    displayName: item.display_name,
    latitude: item.lat,
    longitude: item.lon,
    area,
    city,
    state: a.state,
    postalCode: a.postcode,
    street,
    building,
  });
}

function photonToPlace(f) {
  const p = f.properties || {};
  const [lon, lat] = f.geometry?.coordinates ?? [0, 0];
  const area =
    p.district ||
    p.suburb ||
    p.locality ||
    p.neighbourhood ||
    p.street ||
    p.name;
  const city = p.city || p.town || p.county;
  const label =
    [area, city]
      .filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .join(", ") || p.name;
  const displayName = [
    p.name,
    p.street,
    area,
    city,
    p.state,
    p.postcode,
    p.country,
  ]
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join(", ");
  return makePlace({
    label,
    displayName,
    latitude: lat,
    longitude: lon,
    area,
    city,
    state: p.state,
    postalCode: p.postcode,
    street: p.street,
    building: p.housenumber || p.name,
  });
}

function bigDataCloudToPlace(d, latitude, longitude) {
  const area =
    d.locality ||
    d.localityInfo?.administrative?.find((a) => a.order >= 6)?.name;
  const city = d.city || d.principalSubdivision;
  const label = [area, city]
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join(", ");
  const displayName = [area, city, d.principalSubdivision, d.countryName]
    .filter(Boolean)
    .join(", ");
  return makePlace({
    label,
    displayName,
    latitude,
    longitude,
    area,
    city,
    state: d.principalSubdivision,
    postalCode: d.postcode,
  });
}

const provider = {
  search: (query) =>
    fetchJson(
      "/search",
      {
        format: "jsonv2",
        q: query,
        limit: 6,
        addressdetails: 1,
        countrycodes: env.geocoder.countryCodes,
      },
      { "User-Agent": env.geocoder.userAgent, "Accept-Language": "en" },
    ),
  reverse: (latitude, longitude) =>
    fetchJson(
      "/reverse",
      {
        format: "jsonv2",
        lat: latitude,
        lon: longitude,
        zoom: 16,
        addressdetails: 1,
      },
      { "User-Agent": env.geocoder.userAgent, "Accept-Language": "en" },
    ),
};

async function fallbackSearch(query) {
  const data = await fetchJson(
    "https://photon.komoot.io/api/",
    { q: query, limit: 6 },
    { "Accept-Language": "en" },
  );
  return (Array.isArray(data.features) ? data.features : []).map(photonToPlace);
}

async function fallbackReverse(latitude, longitude) {
  try {
    const data = await fetchJson(
      "https://photon.komoot.io/reverse",
      { lat: latitude, lon: longitude },
      { "Accept-Language": "en" },
    );
    if (data.features?.[0])
      return { ...photonToPlace(data.features[0]), latitude, longitude };
  } catch (err) {
    logger.debug({ err }, "Photon reverse geocode failed, trying BigDataCloud");
  }
  const bdc = await fetchJson(
    "https://api.bigdatacloud.net/data/reverse-geocode-client",
    { latitude, longitude, localityLanguage: "en" },
  );
  return bigDataCloudToPlace(bdc, latitude, longitude);
}

export function search(query) {
  const q = query.trim();
  return upstream.get(`s:${q.toLowerCase()}`, async () => {
    try {
      const places = (await provider.search(q)).map(toPlace);
      if (places.length) return places;
      try {
        const fallbacks = await fallbackSearch(q);
        if (fallbacks.length) return fallbacks;
      } catch {
        /* return original empty */
      }
      return places;
    } catch (err) {
      logger.warn(
        { err, query: q },
        "Nominatim search failed, attempting fallback",
      );
      try {
        return await fallbackSearch(q);
      } catch (fallbackErr) {
        logger.warn(
          { err: fallbackErr, query: q },
          "Geocoding search failed completely",
        );
        throw new ApiError(
          503,
          "Location search is unavailable right now. Please try again.",
          { code: "GEOCODER_UNAVAILABLE" },
        );
      }
    }
  });
}

export function reverse(latitude, longitude) {
  // ~110 m grid so nearby lookups share a cache entry.
  return upstream.get(
    `r:${latitude.toFixed(3)},${longitude.toFixed(3)}`,
    async () => {
      try {
        const result = await provider.reverse(latitude, longitude);
        if (!result || result.error)
          throw new Error("Nominatim could not reverse geocode");
        return { ...toPlace(result), latitude, longitude };
      } catch (err) {
        logger.warn(
          { err, latitude, longitude },
          "Nominatim reverse failed, attempting fallback",
        );
        try {
          return await fallbackReverse(latitude, longitude);
        } catch (fallbackErr) {
          logger.warn(
            { err: fallbackErr, latitude, longitude },
            "All reverse geocoders failed",
          );
          throw ApiError.notFound("No address found for this location");
        }
      }
    },
  );
}

/** Test helper. */
export const clearGeocodingCache = () => upstream.clear();
