import { Writable } from "node:stream";
import pino from "pino";
import { env } from "./env.js";

const redactOptions = {
  paths: [
    "req.headers.authorization",
    "req.headers.cookie",
    'res.headers["set-cookie"]',
    "*.password",
    "*.passwordHash",
    "*.token",
    "*.refreshToken",
  ],
  censor: "[REDACTED]",
};

const devStream = new Writable({
  write(chunk, _encoding, callback) {
    try {
      const log = JSON.parse(chunk.toString());
      const msg = log.msg || "";
      if (log.err?.stack) {
        console.error(msg ? `[ERROR] ${msg}\n${log.err.stack}` : log.err.stack);
      } else if (log.level >= 50) {
        console.error(`[ERROR] ${msg}`, log.err || "");
      } else if (log.level >= 40) {
        console.warn(`[WARN] ${msg}`);
      } else if (msg) {
        console.log(msg);
      }
    } catch {
      process.stdout.write(chunk);
    }
    callback();
  },
});

export const logger = env.isProduction
  ? pino({ level: env.logLevel, redact: redactOptions })
  : pino({ level: env.logLevel, redact: redactOptions }, devStream);
