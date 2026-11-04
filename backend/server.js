import http from "node:http";
import { createApp } from "./app.js";
import { connectDB, disconnectDB } from "./config/db.js";
import { cloudinaryEnabled } from "./config/cloudinary.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { Order } from "./models/order.model.js";
import { startDispatchLoop } from "./services/dispatch.service.js";
import { attachRealtime } from "./sockets/index.js";

const app = createApp();
const server = http.createServer(app);
let io;

async function start() {
  try {
    await connectDB(env.mongoUri);
    io = attachRealtime(server);
  } catch (error) {
    logger.fatal({ err: error }, "Could not connect to MongoDB");
    process.exit(1);
  }
  try {
    await Order.updateMany(
      { submittedAt: { $exists: false } },
      [{ $set: { submittedAt: "$createdAt" } }],
      { updatePipeline: true },
    );
  } catch (err) {
    logger.error({ err }, "Could not backfill order submittedAt");
  }
  server.listen(env.port, () =>
    logger.info(`Server is running on port ${env.port}`),
  );
  logger.debug(
    `Images are stored ${cloudinaryEnabled ? "in Cloudinary" : "on local disk (set CLOUDINARY_* to use Cloudinary)"}`,
  );
  stopDispatch = startDispatchLoop();
}

let stopDispatch = () => {};

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully`);
  stopDispatch();
  if (io) io.close();

  const forceExit = setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(async () => {
    await disconnectDB().catch((error) =>
      logger.error({ err: error }, "Error closing MongoDB"),
    );
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) =>
  logger.error({ err: reason }, "Unhandled promise rejection"),
);

start();
