import express from "express";
import mongoose from "mongoose";
import { hasPermission } from "../config/permissions.js";
import { authenticate } from "../middleware/auth.middleware.js";

// Express 5 no longer exposes where a router is mounted, so record it while the app is built.
const use = express.application.use;
express.application.use = function (path, ...handlers) {
  if (typeof path === "string")
    for (const h of handlers.flat()) if (h?.stack) h.mountPath = path;
  return use.call(this, path, ...handlers);
};

/** Builds the app with mount paths recorded (pass the test helper's buildApp or createApp). */
export async function appWithRoutes(build) {
  try {
    return await build();
  } finally {
    express.application.use = use;
  }
}

const sampleId = () => String(new mongoose.Types.ObjectId());

/**
 * Every API route with the guards that run before it: { method, path ("/api/v1/orders/{id}"),
 * url (ids filled in), auth (authenticate runs), roles: [[...]], permissions: [[...]] }.
 * `roles` / `permissions` are the lists given to each authorize(...) / can(...) on the way.
 */
export function routeTable(app) {
  const routes = [];
  const walk = (stack, prefix, inherited) => {
    const active = [...inherited];
    for (const layer of stack) {
      if (layer.route) {
        const relative = layer.route.path.replace(/:(\w+)/g, () => sampleId());
        const url = (prefix + relative).replace(/\/$/, "");
        const applies = active.filter((m) => m.layer.match(url.slice(m.prefix.length) || "/"));
        for (const method of Object.keys(layer.route.methods).filter((m) => m !== "_all")) {
          const handlers = [
            ...applies.map((m) => m.layer.handle),
            ...layer.route.stack.filter((l) => !l.method || l.method === method).map((l) => l.handle),
          ];
          routes.push({
            method,
            path: (prefix + layer.route.path).replace(/\/$/, "").replace(/:(\w+)/g, "{$1}"),
            url,
            auth: handlers.includes(authenticate),
            roles: handlers.filter((h) => h.roles).map((h) => h.roles),
            permissions: handlers.filter((h) => h.permissions).map((h) => h.permissions),
          });
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, prefix + (layer.handle.mountPath ?? ""), active);
      } else {
        active.push({ layer, prefix });
      }
    }
  };
  walk(app.router.stack, "", []);
  return routes.filter((r) => r.path.includes("/api/v1/"));
}

/** What the route's own guards say for this role (undefined: anonymous). */
export const allows = (r, role) =>
  (!r.auth || Boolean(role)) &&
  r.roles.every((list) => list.includes(role)) &&
  r.permissions.every((list) => Boolean(role) && list.some((p) => hasPermission(role, p)));
