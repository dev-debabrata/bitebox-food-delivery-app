import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tests must never pick up real credentials from .env.
if (process.env.NODE_ENV !== "test") {
  dotenv.config({ quiet: true });
  // Also check backend/.env when running from repo root
  dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });
  dotenv.config({ path: path.resolve(__dirname, "../../.env"), quiet: true });
}

/**
 * Centralised, validated environment configuration.
 * Every other module reads settings from here instead of process.env,
 * so a missing or malformed variable fails fast at startup.
 */

const nodeEnv = process.env.NODE_ENV || "development";
const isTest = nodeEnv === "test";
const isProduction = nodeEnv === "production";
/** Cloudinary keys are ignored in tests, so a test run never uploads anywhere. */
const cloudKey = (name) => (isTest ? "" : process.env[name] || "");

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

  // Image hosting: Cloudinary when all three keys are set (never in tests), otherwise local disk.
  cloudinary: {
    cloudName: cloudKey("CLOUDINARY_CLOUD_NAME"),
    apiKey: cloudKey("CLOUDINARY_API_KEY"),
    apiSecret: cloudKey("CLOUDINARY_API_SECRET"),
    folder: process.env.CLOUDINARY_FOLDER || "bitebox",
  },

  // Local-disk fallback: where uploaded images are stored, and the public origin used in their URLs.
  uploadDir: process.env.UPLOAD_DIR || (isTest ? "tmp/test-uploads" : "uploads"),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${integer("PORT", 5000)}`).replace(/\/$/, ""),

  // Place search / reverse geocoding (OpenStreetMap Nominatim by default; see geocoding.service.js).
  geocoder: {
    url: process.env.GEOCODER_URL || "https://nominatim.openstreetmap.org",
    // Nominatim's policy requires an identifying User-Agent with contact details.
    // Replace placeholder emails like you@example.com which Nominatim blocks with HTTP 403.
    userAgent: (() => {
      const raw = (process.env.GEOCODER_USER_AGENT || "").replace(/^"|"$/g, "").trim();
      if (!raw || raw.toLowerCase().includes("example.com")) {
        return "BiteBoxApp/1.0 (BiteBox Food Delivery Platform; contact: support@bitebox.local)";
      }
      return raw;
    })(),
    // Comma-separated ISO country codes to limit search results (empty = worldwide).
    countryCodes: process.env.GEOCODER_COUNTRY_CODES ?? "in",
  },

  // Online payments (see services/payments). Razorpay is used only when both keys are set;
  // otherwise the clearly-labelled mock provider is offered outside production.
  payments: {
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || "",
    razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "",
    mockEnabled: !isProduction && process.env.PAYMENTS_MOCK !== "false",
  },

  // Days in reports and earnings are counted in this time zone.
  reportTimezone: process.env.REPORT_TIMEZONE || "Asia/Kolkata",

  // Road routes and travel-time estimates (OSRM by default; see routing.service.js).
  routing: {
    url: process.env.ROUTING_URL || "https://router.project-osrm.org",
    // OSRM profile: "driving" suits motorbikes and scooters well enough for estimates.
    profile: process.env.ROUTING_PROFILE || "driving",
    userAgent: process.env.GEOCODER_USER_AGENT || "BiteBox/1.0 (development)",
  },

  logLevel: process.env.LOG_LEVEL || (isTest ? "silent" : isProduction ? "info" : "debug"),
});
