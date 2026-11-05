import mongoose from "mongoose";
import { createApp } from "../app.js";
import { connectDB } from "../config/db.js";
import { env } from "../config/env.js";

const app = createApp();

let isConnecting = null;

async function ensureConnected() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (!isConnecting) {
    isConnecting = connectDB(env.mongoUri)
      .then((conn) => {
        isConnecting = null;
        return conn;
      })
      .catch((err) => {
        isConnecting = null;
        throw err;
      });
  }

  return isConnecting;
}

export default async function handler(req, res) {
  try {
    await ensureConnected();
  } catch (err) {
    console.error("Vercel DB Connection Error:", err);
    return res.status(503).json({
      success: false,
      message:
        "Database connection failed. Please ensure MongoDB Atlas Network Access allows 0.0.0.0/0.",
      error: {
        code: "DATABASE_CONNECTION_ERROR",
        details: err?.message || String(err),
      },
    });
  }

  return app(req, res);
}
