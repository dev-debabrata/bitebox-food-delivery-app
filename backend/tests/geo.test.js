import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { clearGeocodingCache } from "../services/geocoding.service.js";
import { buildApp, request, setupTestDb, teardownTestDb } from "./helpers.js";

// The real provider is never called in tests: fetch is replaced with a stub.
const realFetch = globalThis.fetch;
let calls = [];
let reply = () => ({ ok: true, json: async () => [] });

describe("location search (geocoding proxy)", () => {
  let app;
  before(async () => {
    await setupTestDb();
    app = buildApp();
    globalThis.fetch = async (url, init) => {
      calls.push({ url: new URL(url), init });
      return reply(new URL(url));
    };
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await teardownTestDb();
  });
  beforeEach(() => {
    calls = [];
    clearGeocodingCache();
  });

  it("returns short labels from search results and identifies itself to the provider", async () => {
    reply = () => ({
      ok: true,
      json: async () => [
        { lat: "11.5", lon: "21.5", display_name: "Sample Area, Sample City, Test State", address: { suburb: "Sample Area", city: "Sample City", state: "Test State", postcode: "100002" } },
      ],
    });
    const res = await request(app).get("/api/v1/geo/search?q=topsia");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.places[0], {
      label: "Sample Area, Sample City",
      displayName: "Sample Area, Sample City, Test State",
      latitude: 11.5,
      longitude: 21.5,
      area: "Sample Area",
      city: "Sample City",
      state: "Test State",
      postalCode: "100002",
    });
    assert.match(calls[0].init.headers["User-Agent"], /BiteBox/);
    assert.equal(calls[0].url.searchParams.get("countrycodes"), "in");
  });

  it("caches repeated lookups so the free provider is not hammered", async () => {
    reply = () => ({ ok: true, json: async () => ({ lat: "10.5", lon: "20.5", display_name: "Test Area", address: { suburb: "Test Area", city: "Test City" } }) });
    await request(app).get("/api/v1/geo/reverse?lat=10.500000&lng=20.500000");
    const second = await request(app).get("/api/v1/geo/reverse?lat=10.5&lng=20.5");
    assert.equal(calls.length, 1);
    assert.equal(second.body.data.place.label, "Test Area, Test City");
  });

  it("validates input and reports provider outages as 503", async () => {
    assert.equal((await request(app).get("/api/v1/geo/search?q=ab")).status, 422);
    assert.equal((await request(app).get("/api/v1/geo/reverse?lat=200&lng=1")).status, 422);
    reply = () => ({ ok: false, status: 500, json: async () => ({}) });
    const res = await request(app).get("/api/v1/geo/search?q=kolkata");
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "GEOCODER_UNAVAILABLE");
  });
});
