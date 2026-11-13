import { createApp } from "../app.js";
import { connectDB } from "../config/db.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const app = createApp();
let connecting;

export default async function handler(req, res) {
  try {
    if (env.mongoUri) {
      await (connecting ??= connectDB(env.mongoUri).catch((err) => {
        connecting = null;
        throw err;
      }));
    }
    return app(req, res);
  } catch (err) {
    logger.error({ err }, "Backend handler error");
    return res.status(503).json({
      success: false,
      message: err.message || "Service temporarily unavailable",
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  }
}
