import mongoose from "mongoose";
import { emptyRating, ratingSummarySchema } from "./rating-summary.schema.js";

export const RESTAURANT_STATUS = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  SUSPENDED: "suspended",
  // BiteBox asked for documents or details again; the owner fixes them and resubmits.
  RESUBMISSION_REQUESTED: "resubmission_requested",
});

export const ADMIN_STATUS_TRANSITIONS = Object.freeze({
  pending: ["approved", "rejected", "resubmission_requested"],
  resubmission_requested: ["approved", "rejected"],
  approved: ["suspended"],
  suspended: ["approved"],
  rejected: ["approved"],
});

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const addressSchema = new mongoose.Schema(
  {
    line1: { type: String, required: true, trim: true, maxlength: 120 },
    line2: { type: String, trim: true, maxlength: 120 },
    area: { type: String, trim: true, maxlength: 80 },
    city: { type: String, required: true, trim: true, maxlength: 60 },
    state: { type: String, required: true, trim: true, maxlength: 60 },
    postalCode: {
      type: String,
      required: true,
      trim: true,
      match: /^[A-Za-z0-9 -]{3,10}$/,
    },
  },
  { _id: false },
);

const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["Point"], required: true, default: "Point" },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: ([lng, lat] = []) =>
          lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90,
        message:
          "Coordinates must be [longitude, latitude] within valid ranges",
      },
    },
  },
  { _id: false },
);

const restaurantSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, trim: true, maxlength: 1000 },
    cuisines: {
      type: [{ type: String, trim: true, minlength: 2, maxlength: 40 }],
      validate: {
        validator: (v) => v.length >= 1 && v.length <= 10,
        message: "Add between 1 and 10 cuisines",
      },
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      match: /^\+?[0-9]{10,15}$/,
    },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    address: { type: addressSchema, required: true },
    location: { type: pointSchema, required: true },
    imageUrl: { type: String, trim: true, maxlength: 500 },

    isPureVeg: { type: Boolean, default: false },
    costForTwoPaise: {
      type: Number,
      required: true,
      min: 0,
      max: 10_000_000,
      validate: Number.isInteger,
    },
    minOrderPaise: {
      type: Number,
      default: 0,
      min: 0,
      max: 10_000_000,
      validate: Number.isInteger,
    },
    avgPrepTimeMinutes: { type: Number, default: 25, min: 5, max: 180 },

    // Legal and tax details (shown to admins; the FSSAI number is also shown to customers).
    ownerName: { type: String, trim: true, maxlength: 80 },
    gstRegistered: { type: Boolean, default: false },
    gstin: { type: String, trim: true, uppercase: true, maxlength: 15 },
    fssaiNumber: { type: String, trim: true, maxlength: 14 },
    fssaiValidUntil: { type: Date },
    photos: { type: [String], default: [] }, // up to 8 gallery images (our uploads)
    // { mon: [{ open: "09:00", close: "23:00" }], ..., sun: [] }; unset: the daily hours below.
    weeklyHours: { type: mongoose.Schema.Types.Mixed, default: undefined },
    // Daily hours (one slot), used when there are no weekly hours.
    openingTime: { type: String, required: true, match: TIME_PATTERN },
    closingTime: { type: String, required: true, match: TIME_PATTERN },
    timezone: { type: String, default: "Asia/Kolkata" },
    isAcceptingOrders: { type: Boolean, default: true },

    status: {
      type: String,
      enum: Object.values(RESTAURANT_STATUS),
      default: RESTAURANT_STATUS.PENDING,
    },
    statusReason: { type: String, trim: true, maxlength: 500 },
    reviewedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    rating: { type: ratingSummarySchema, default: emptyRating },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = String(ret._id);
        delete ret._id;
        return ret;
      },
    },
  },
);

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** The minute of the day and the day of the week ("mon") in a time zone. */
function localNow(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(now)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return { minute: Number(parts.hour) * 60 + Number(parts.minute), day: parts.weekday.toLowerCase().slice(0, 3) };
}

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** The part of a slot on its own day (an overnight slot runs to midnight). */
const openToday = ([open, close], now) =>
  open === close || (open < close ? now >= open && now < close : now >= open); // equal: 24 hours

/**
 * Open within today's hours in the restaurant's time zone (same rules as Django). Weekly hours,
 * when set, give each day its own slots; a slot ending after midnight still counts next morning.
 */
export function isOpenAt(r, now = new Date()) {
  if (!r.isAcceptingOrders) return false;
  const { minute, day } = localNow(r.timezone || "Asia/Kolkata", now);
  const slots = (d) => (r.weeklyHours?.[d] ?? []).map((s) => [toMinutes(s.open), toMinutes(s.close)]);
  let today, yesterday;
  if (r.weeklyHours) {
    today = slots(day);
    yesterday = slots(DAYS[(DAYS.indexOf(day) + 6) % 7]);
  } else if (r.openingTime && r.closingTime) {
    today = yesterday = [[toMinutes(r.openingTime), toMinutes(r.closingTime)]];
  } else return false;
  return today.some((s) => openToday(s, minute)) || yesterday.some(([open, close]) => close < open && minute < close);
}

restaurantSchema.virtual("isOpenNow").get(function isOpenNow() {
  return isOpenAt(this);
});

restaurantSchema.index({ owner: 1 }, { unique: true });
restaurantSchema.index({ slug: 1 }, { unique: true });
restaurantSchema.index({ location: "2dsphere" });
restaurantSchema.index({ status: 1, "rating.average": -1 });
restaurantSchema.index({ status: 1, createdAt: -1 });
restaurantSchema.index({ status: 1, cuisines: 1 });

export const Restaurant = mongoose.model("Restaurant", restaurantSchema);
