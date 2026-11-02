import http from "node:http";
import { createApp } from "./app.js";
import { connectDB, disconnectDB } from "./config/db.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { startDispatchLoop } from "./services/dispatch.service.js";
import { attachRealtime } from "./sockets/index.js";

const app = createApp();
// A plain http.Server shared by Express and Socket.IO.
const server = http.createServer(app);
const io = attachRealtime(server);

async function start() {
  try {
    await connectDB(env.mongoUri);
  } catch (error) {
    logger.fatal({ err: error }, "Could not connect to MongoDB");
    process.exit(1);
  }
  server.listen(env.port, () => logger.info(`BiteBox API listening on http://localhost:${env.port} (docs: /api/docs)`));
  // Offer timeouts, re-dispatch of waiting orders, auto-reject of unanswered orders.
  stopDispatch = startDispatchLoop();
}

let stopDispatch = () => {};

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully`);
  stopDispatch();
  io.close();

  // Force exit if open connections do not drain in time.
  const forceExit = setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(async () => {
    await disconnectDB().catch((error) => logger.error({ err: error }, "Error closing MongoDB"));
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "Unhandled promise rejection"));

start();
