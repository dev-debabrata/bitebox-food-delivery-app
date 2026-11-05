import mongoose from "mongoose";
import { createApp } from "../app.js";
import { connectDB } from "../config/db.js";
import { env } from "../config/env.js";

const app = createApp();

let dbPromise = null;

app.use(async (_req, _res, next) => {
  try {
    if (mongoose.connection.readyState === 0) {
      if (!dbPromise) {
        dbPromise = connectDB(env.mongoUri).catch((err) => {
          dbPromise = null;
          throw err;
        });
      }
      await dbPromise;
    }
    next();
  } catch (err) {
    next(err);
  }
});

export default app;
