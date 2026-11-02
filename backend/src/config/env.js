import dotenv from "dotenv";

// Tests must never pick up real credentials from .env.
if (process.env.NODE_ENV !== "test") dotenv.config({ quiet: true });

/**
 * Centralised, validated environment configuration.
 * Every other module reads settings from here instead of process.env,
 * so a missing or malformed variable fails fast at startup.
 */

const nodeEnv = process.env.NODE_ENV || "development";
const isTest = nodeEnv === "test";
const isProduction = nodeEnv === "production";

function required(name, fallbackForTest) {
  const value = process.env[name];
  if (value && value.trim() !== "") return value.trim();
  if (isTest && fallbackForTest !== undefined) return fallbackForTest;
  throw new Error(`Missing required environment variable: ${name}`);
}

function integer(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Environment variable ${name} must be an integer`);
  return parsed;
}

const jwtSecret = required("JWT_SECRET", "test-only-jwt-secret-that-is-long-enough-1234567890");
if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters long");
}

export const env = Object.freeze({
  nodeEnv,
  isTest,
  isProduction,
  port: integer("PORT", 5000),
  mongoUri: required("MONGO_URI", "mongodb://127.0.0.1:27017/bitebox_test"),

  // Comma-separated list of browser origins allowed to call the API.
  clientUrls: (process.env.CLIENT_URL || "http://localhost:4200")
    .split(",")
    .map((url) => url.trim().replace(/\/$/, ""))
    .filter(Boolean),

  jwt: {
    secret: jwtSecret,
    // Access tokens are short-lived and only kept in browser memory.
    accessExpiresIn: process.env.JWT_EXPIRES_IN || "15m",
    issuer: "bitebox-api",
    audience: "bitebox-web",
  },

  refreshToken: {
    ttlDays: integer("REFRESH_TOKEN_TTL_DAYS", 7),
    cookieName: "bb_refresh",
  },

  passwordReset: {
    ttlMinutes: integer("PASSWORD_RESET_TTL_MINUTES", 30),
  },

  bcryptRounds: integer("BCRYPT_ROUNDS", isTest ? 4 : 12),

  smtp: {
    host: process.env.SMTP_HOST || "",
    port: integer("SMTP_PORT", 587),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.EMAIL_FROM || "BiteBox <no-reply@bitebox.local>",
  },

  // Where uploaded images are stored, and the public origin used in their URLs.
  uploadDir: process.env.UPLOAD_DIR || (isTest ? "tmp/test-uploads" : "uploads"),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${integer("PORT", 5000)}`).replace(/\/$/, ""),

  // Place search / reverse geocoding (OpenStreetMap Nominatim by default; see geocoding.service.js).
  geocoder: {
    url: process.env.GEOCODER_URL || "https://nominatim.openstreetmap.org",
    // Nominatim's policy requires an identifying User-Agent with contact details.
    userAgent: process.env.GEOCODER_USER_AGENT || "BiteBox/1.0 (development)",
    // Comma-separated ISO country codes to limit search results (empty = worldwide).
    countryCodes: process.env.GEOCODER_COUNTRY_CODES ?? "in",
  },

  // Road routes and travel-time estimates (OSRM by default; see routing.service.js).
  routing: {
    url: process.env.ROUTING_URL || "https://router.project-osrm.org",
    // OSRM profile: "driving" suits motorbikes and scooters well enough for estimates.
    profile: process.env.ROUTING_PROFILE || "driving",
    userAgent: process.env.GEOCODER_USER_AGENT || "BiteBox/1.0 (development)",
  },

  logLevel: process.env.LOG_LEVEL || (isTest ? "silent" : isProduction ? "info" : "debug"),
});
