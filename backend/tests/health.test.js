import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openApiDocument } from "../docs/openapi.js";
import { buildApp, request, setupTestDb, teardownTestDb } from "./helpers.js";

describe("Health & app basics", () => {
  let app;
  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(teardownTestDb);

  it("reports healthy when the database is connected", async () => {
    const res = await request(app).get("/api/v1/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.database, "connected");
  });

  it("returns a consistent 404 envelope for unknown routes", async () => {
    const res = await request(app).get("/api/v1/does-not-exist");
    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, "NOT_FOUND");
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send("{bad json");
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
  });

  it("rejects oversized payloads with 413", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "a@b.co", password: "x".repeat(200_000) });
    assert.equal(res.status, 413);
  });

  it("sets security headers and hides x-powered-by", async () => {
    const res = await request(app).get("/api/v1/health");
    assert.equal(res.headers["x-powered-by"], undefined);
    assert.ok(res.headers["x-content-type-options"]);
  });

  it("only allows CORS for allow-listed origins", async () => {
    const allowed = await request(app)
      .options("/api/v1/auth/login")
      .set("Origin", "http://localhost:4200")
      .set("Access-Control-Request-Method", "POST");
    assert.equal(
      allowed.headers["access-control-allow-origin"],
      "http://localhost:4200",
    );
    const denied = await request(app)
      .options("/api/v1/auth/login")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "POST");
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
  });

  it("documents only routes that exist", async () => {
    const operations = Object.entries(openApiDocument.paths).flatMap(
      ([path, ops]) =>
        Object.keys(ops).map((method) => [
          method,
          path
            .replace("{id}", "0123456789abcdef01234567")
            .replace("{slugOrId}", "x"),
        ]),
    );
    assert.ok(operations.length > 30);
    for (const [method, path] of operations) {
      const res = await request(app)[method](`/api/v1${path}`);
      assert.ok(
        !String(res.body.message).startsWith("Route not found"),
        `${method.toUpperCase()} ${path} is documented but not routed`,
      );
    }
  });

  it("serves the OpenAPI document", async () => {
    const res = await request(app).get("/api/docs.json");
    assert.equal(res.status, 200);
    assert.ok(res.body.paths["/auth/login"]);
  });
});
