import { Router } from "express";
import mongoose from "mongoose";
import { dbState } from "../config/db.js";

const router = Router();

async function checkDatabase() {
  let database = dbState();
  if (database === "connected") {
    try {
      await mongoose.connection.db.admin().command({ ping: 1 });
    } catch {
      database = "unreachable";
    }
  }
  return database;
}

// Liveness: the process is running (no dependencies checked, so a slow database never restarts it).
router.get("/live", (_req, res) => {
  res.json({ success: true, message: "OK", data: { status: "alive" } });
});

// Readiness: able to serve (the database answers). Load balancers stop routing here on 503.
router.get("/ready", async (_req, res) => {
  const ready = (await checkDatabase()) === "connected";
  res
    .status(ready ? 200 : 503)
    .set("Cache-Control", "no-store")
    .json({ success: ready, message: "OK", data: { status: ready ? "ready" : "not_ready" } });
});

router.get("/", async (_req, res) => {
  const database = await checkDatabase();
  const healthy = database === "connected";
  res.status(healthy ? 200 : 503).json({
    success: healthy,
    message: healthy ? "BiteBox API is healthy" : "BiteBox API is degraded",
    data: {
      status: healthy ? "ok" : "degraded",
      database,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
  });
});

export default router;
