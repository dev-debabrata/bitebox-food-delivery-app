import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (process.env.NODE_ENV !== "test") {
  dotenv.config({ quiet: true });
  dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });
  dotenv.config({ path: path.resolve(__dirname, "../../.env"), quiet: true });
}

const nodeEnv = process.env.NODE_ENV || "development";
const isTest = nodeEnv === "test";
const isProduction = nodeEnv === "production";
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
  if (Number.isNaN(parsed))
    throw new Error(`Environment variable ${name} must be an integer`);
  return parsed;
}

const jwtSecret = required(
  "JWT_SECRET",
  "test-only-jwt-secret-that-is-long-enough-1234567890",
);
if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters long");
}

function fieldEncryptionKey() {
  const key = process.env.FIELD_ENCRYPTION_KEY || "";
  if (isProduction && !key) throw new Error("FIELD_ENCRYPTION_KEY must be set (32 bytes, base64)");
  return key;
}

export const env = Object.freeze({
  nodeEnv,
  isTest,
  isProduction,
  port: integer("PORT", 5000),
  mongoUri: required("MONGO_URI", "mongodb://127.0.0.1:27017/bitebox_test"),

  clientUrls: (process.env.CLIENT_URL || "http://localhost:4200")
    .split(",")
    .map((url) => url.trim().replace(/\/$/, ""))
    .filter(Boolean),

  jwt: {
    secret: jwtSecret,
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

  emailVerification: { ttlHours: integer("EMAIL_VERIFICATION_TTL_HOURS", 24) },
  // Sign-up texts a code to the new number and creates the account only with it (while SMS is
  // on). Tests register in one step unless they turn it on.
  signupOtpRequired: !isTest && process.env.SIGNUP_OTP_REQUIRED !== "false",
  // Phone sign-in codes (services/otp.service.js): 6 digits, 5 minutes, 5 tries, a new code after
  // 30 s, at most 5 codes per number and 20 per IP address an hour.
  otp: {
    ttlSeconds: integer("OTP_TTL_SECONDS", 300),
    maxAttempts: 5,
    resendSeconds: integer("OTP_RESEND_SECONDS", 30),
    perPhonePerHour: integer("OTP_PER_PHONE_PER_HOUR", 5),
    perIpPerHour: integer("OTP_PER_IP_PER_HOUR", 20),
  },

  bcryptRounds: integer("BCRYPT_ROUNDS", isTest ? 4 : 12),

  smtp: {
    host: process.env.SMTP_HOST || "",
    port: integer("SMTP_PORT", 587),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.EMAIL_FROM || "BiteBox <no-reply@bitebox.local>",
  },

  cloudinary: {
    cloudName: cloudKey("CLOUDINARY_CLOUD_NAME"),
    apiKey: cloudKey("CLOUDINARY_API_KEY"),
    apiSecret: cloudKey("CLOUDINARY_API_SECRET"),
    folder: process.env.CLOUDINARY_FOLDER || "bitebox",
  },

  // Tests always use their own folder, so they never write into the development uploads.
  uploadDir: isTest
    ? "tmp/test-uploads"
    : process.env.UPLOAD_DIR || "uploads",
  // KYC documents (services/kyc.service.js): never served by URL, only through the API.
  privateUploadDir: isTest
    ? "tmp/test-private-uploads"
    : process.env.PRIVATE_UPLOAD_DIR || "private-uploads",
  // AES-256-GCM key (32 bytes, base64) for bank and document numbers (utils/field-crypto.js).
  fieldEncryptionKey: fieldEncryptionKey(),
  // A restaurant goes live only with its required documents approved and a bank account added.
  restaurantKycRequired: !isTest && process.env.RESTAURANT_KYC_REQUIRED !== "false",
  // A rider goes online only once approved: documents, bank account and address.
  riderKycRequired: !isTest && process.env.RIDER_KYC_REQUIRED !== "false",
  publicBaseUrl: (
    process.env.PUBLIC_BASE_URL || `http://localhost:${integer("PORT", 5000)}`
  ).replace(/\/$/, ""),

  geocoder: {
    url: process.env.GEOCODER_URL || "https://nominatim.openstreetmap.org",
    userAgent: (() => {
      const raw = (process.env.GEOCODER_USER_AGENT || "")
        .replace(/^"|"$/g, "")
        .trim();
      if (!raw || raw.toLowerCase().includes("example.com")) {
        return "BiteBoxApp/1.0 (BiteBox Food Delivery Platform; contact: support@bitebox.local)";
      }
      return raw;
    })(),
    countryCodes: process.env.GEOCODER_COUNTRY_CODES ?? "in",
  },

  payments: {
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || "",
    razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "",
    mockEnabled: !isProduction && process.env.PAYMENTS_MOCK !== "false",
  },

  reportTimezone: process.env.REPORT_TIMEZONE || "Asia/Kolkata",

  // Delivery tracking: a rider's position is stored at most every sampleSeconds while they carry
  // an order, kept retentionDays, and shown as stale after staleSeconds. An arrival further than
  // arrivalFarMeters from the restaurant is allowed but flagged for admins.
  tracking: {
    sampleSeconds: Number(process.env.TRACKING_SAMPLE_SECONDS) || 15,
    retentionDays: Number(process.env.TRACKING_RETENTION_DAYS) || 30,
    staleSeconds: Number(process.env.TRACKING_STALE_SECONDS) || 90,
    arrivalFarMeters: Number(process.env.ARRIVAL_FAR_METERS) || 200,
  },

  // Notification channels beside in-app and Web Push. Email uses SMTP (NOTIFICATION_EMAILS=false
  // turns notification emails off); SMS uses MSG91 or the log ("console"); FCM (future native
  // apps) needs a Firebase service account JSON file. Each is off until configured.
  notifications: {
    emails: process.env.NOTIFICATION_EMAILS !== "false",
    // Unset outside production: "console" (codes are printed in the server log, nothing is sent).
    smsProvider: isTest ? "" : (process.env.SMS_PROVIDER || "").trim(),
    msg91AuthKey: process.env.MSG91_AUTH_KEY || "",
    msg91TemplateId: process.env.MSG91_TEMPLATE_ID || "",
    // OTP messages need their own DLT-approved template in India (falls back to the one above).
    msg91OtpTemplateId: process.env.MSG91_OTP_TEMPLATE_ID || "",
    fcmCredentialsFile: isTest ? "" : (process.env.FCM_CREDENTIALS_FILE || "").trim(),
    // "Your rider is almost there" when the rider on the way comes this close to the customer.
    approachMeters: Number(process.env.APPROACH_NOTIFY_METERS) || 500,
  },

  // Delivery OTP: a 4-digit code made at pickup, shown to the customer, needed to mark delivered.
  deliveryOtp: {
    required: process.env.DELIVERY_OTP_REQUIRED !== "false",
    maxAttempts: Number(process.env.DELIVERY_OTP_MAX_ATTEMPTS) || 5,
  },

  // Web Push (browser notifications). Push is on only when both VAPID keys are set; generate
  // them once with `npx web-push generate-vapid-keys`. The private key never leaves the API.
  // Tests never use real keys: they swap in a fake sender (services/push.service.js#usePushSender).
  push: {
    vapidPublicKey: isTest ? "" : (process.env.VAPID_PUBLIC_KEY || "").trim(),
    vapidPrivateKey: isTest ? "" : (process.env.VAPID_PRIVATE_KEY || "").trim(),
    // A contact the push services can reach about abuse: mailto: or https: URL.
    subject: process.env.VAPID_SUBJECT || "mailto:support@bitebox.local",
    // Subscriptions may only point at these push services (the API sends requests to the
    // endpoint, so any other host is refused). Suffix match on the endpoint's host name.
    allowedHosts: (
      process.env.PUSH_ALLOWED_HOSTS ||
      "fcm.googleapis.com,push.services.mozilla.com,notify.windows.com,push.apple.com"
    )
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  },

  routing: {
    url: process.env.ROUTING_URL || "https://router.project-osrm.org",
    profile: process.env.ROUTING_PROFILE || "driving",
    userAgent: process.env.GEOCODER_USER_AGENT || "BiteBox/1.0 (development)",
  },

  logLevel:
    process.env.LOG_LEVEL ||
    (isTest ? "silent" : isProduction ? "info" : "debug"),
});
