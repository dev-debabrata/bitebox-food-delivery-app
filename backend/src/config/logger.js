import pino from "pino";
import { env } from "./env.js";

/**
 * Structured JSON logger. Sensitive fields are redacted so secrets,
 * passwords and tokens never reach log output.
 */
export const logger = pino({
  level: env.logLevel,
  redact: {
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
  },
});
