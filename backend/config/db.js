import mongoose from "mongoose";
import { logger } from "./logger.js";

mongoose.set("strictQuery", true);

let listenersRegistered = false;
function registerListeners() {
  if (listenersRegistered) return;
  listenersRegistered = true;
  mongoose.connection.on("disconnected", () =>
    logger.warn("MongoDB disconnected"),
  );
  mongoose.connection.on("reconnected", () =>
    logger.info("MongoDB reconnected"),
  );
  mongoose.connection.on("error", (error) =>
    logger.error({ err: error }, "MongoDB error"),
  );
}

export const connectDB = async (uri) => {
  registerListeners();
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }
  const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  logger.info("MongoDB connected");
  return conn;
};

export const disconnectDB = async () => {
  await mongoose.connection.close();
  logger.info("MongoDB connection closed");
};

const STATES = ["disconnected", "connected", "connecting", "disconnecting"];
export const dbState = () =>
  STATES[mongoose.connection.readyState] ?? "unknown";
