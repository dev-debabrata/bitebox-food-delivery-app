import { createApp } from "../app.js";
import { connectDB } from "../config/db.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const app = createApp();
let connecting = null;

export default async function handler(req, res) {
  try {
    await (connecting ??= connectDB(env.mongoUri).catch((err) => {
      connecting = null; // let the next request try again
      throw err;
    }));
  } catch (err) {
    logger.error({ err }, "MongoDB connection failed");
    return res.status(503).json({
      success: false,
      message: "Service temporarily unavailable, please retry",
      error: { code: "DATABASE_UNAVAILABLE" },
    });
  }
  return app(req, res);
}
