import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "../app.js";
import { openApiDocument } from "../docs/openapi.js";
import { appWithRoutes, routeTable } from "./route-table.js";

const app = await appWithRoutes(createApp);
/** "get /api/v1/orders/{id}" for every route the app serves. */
const appRoutes = (app) => routeTable(app).map((r) => `${r.method} ${r.path}`);

describe("API documentation", () => {
  const routes = appRoutes(app);
  const documented = Object.entries(openApiDocument.paths).flatMap(
    ([path, ops]) =>
      Object.keys(ops).map((method) =>
        `${method} /api/v1${path}`.replace(/\/$/, ""),
      ),
  );

  it("documents every API route in OpenAPI", () => {
    assert.ok(routes.length > 80, `found ${routes.length} routes`);
    assert.deepEqual(
      routes.filter((r) => !documented.includes(r)),
      [],
      "add these to src/docs/openapi.*.js",
    );
  });

  it("documents no route that does not exist", () => {
    assert.deepEqual(
      documented.filter((d) => !routes.includes(d)),
      [],
    );
  });
});
