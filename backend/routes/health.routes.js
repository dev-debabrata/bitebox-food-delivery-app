import { Router } from "express";
import mongoose from "mongoose";
import { dbState } from "../config/db.js";

const router = Router();

router.get("/", async (_req, res) => {
  let database = dbState();
  if (database === "connected") {
    try {
      await mongoose.connection.db.admin().command({ ping: 1 });
    } catch {
      database = "unreachable";
    }
  }
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
