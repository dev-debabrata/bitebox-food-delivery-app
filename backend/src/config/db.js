import mongoose from "mongoose";
import { logger } from "./logger.js";

// Reject query filters on fields that are not defined in the schema.
mongoose.set("strictQuery", true);

export const connectDB = async (uri) => {
  mongoose.connection.on("disconnected", () => logger.warn("MongoDB disconnected"));
  mongoose.connection.on("reconnected", () => logger.info("MongoDB reconnected"));
  mongoose.connection.on("error", (error) => logger.error({ err: error }, "MongoDB error"));

  const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  logger.info(`MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
  return conn;
};

export const disconnectDB = async () => {
  await mongoose.connection.close();
  logger.info("MongoDB connection closed");
};

const STATES = ["disconnected", "connected", "connecting", "disconnecting"];
export const dbState = () => STATES[mongoose.connection.readyState] ?? "unknown";
