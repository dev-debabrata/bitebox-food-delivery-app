import mongoose from "mongoose";
import { createApp } from "../app.js";
import { connectDB } from "../config/db.js";
import { env } from "../config/env.js";

let app = null;

async function bootstrap() {
  if (mongoose.connection.readyState === 0) {
    await connectDB(env.mongoUri);
  }
  if (!app) {
    app = createApp();
  }
  return app;
}

export default async function handler(req, res) {
  const expressApp = await bootstrap();
  return expressApp(req, res);
}

