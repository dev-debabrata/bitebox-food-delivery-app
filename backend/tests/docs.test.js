import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

// Express 5 no longer exposes where a router is mounted, so record it while the app is built.
const use = express.application.use;
express.application.use = function (path, ...handlers) {
  if (typeof path === "string") for (const h of handlers.flat()) if (h?.stack) h.mountPath = path;
  return use.call(this, path, ...handlers);
};
const { createApp } = await import("../app.js");
const { openApiDocument } = await import("../docs/openapi.js");
const app = createApp();
express.application.use = use;

/** "get /api/v1/orders/{id}" for every route the app serves. */
function appRoutes(app) {
  const routes = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        const path = (prefix + layer.route.path).replace(/\/$/, "").replace(/:(\w+)/g, "{$1}");
        for (const method of Object.keys(layer.route.methods)) routes.push(`${method} ${path}`);
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, prefix + (layer.handle.mountPath ?? ""));
      }
    }
  };
  walk(app.router.stack, "");
  return routes.filter((r) => r.includes("/api/v1/"));
}

describe("API documentation", () => {
  const routes = appRoutes(app);
  const documented = Object.entries(openApiDocument.paths).flatMap(([path, ops]) =>
    Object.keys(ops).map((method) => `${method} /api/v1${path}`.replace(/\/$/, "")),
  );

  it("documents every API route in OpenAPI", () => {
    assert.ok(routes.length > 80, `found ${routes.length} routes`);
    assert.deepEqual(routes.filter((r) => !documented.includes(r)), [], "add these to src/docs/openapi.*.js");
  });

  it("documents no route that does not exist", () => {
    assert.deepEqual(documented.filter((d) => !routes.includes(d)), []);
  });
});
