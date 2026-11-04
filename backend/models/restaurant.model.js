import mongoose from "mongoose";
import { emptyRating, ratingSummarySchema } from "./rating-summary.schema.js";

export const RESTAURANT_STATUS = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  SUSPENDED: "suspended",
});

export const ADMIN_STATUS_TRANSITIONS = Object.freeze({
  pending: ["approved", "rejected"],
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

function minutesNow(timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(new Date())
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return Number(parts.hour) * 60 + Number(parts.minute);
}

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

restaurantSchema.virtual("isOpenNow").get(function isOpenNow() {
  if (!this.isAcceptingOrders || !this.openingTime || !this.closingTime)
    return false;
  const now = minutesNow(this.timezone || "Asia/Kolkata");
  const open = toMinutes(this.openingTime);
  const close = toMinutes(this.closingTime);
  if (open === close) return true; // open 24 hours
  return open < close ? now >= open && now < close : now >= open || now < close;
});

restaurantSchema.index({ owner: 1 }, { unique: true });
restaurantSchema.index({ slug: 1 }, { unique: true });
restaurantSchema.index({ location: "2dsphere" });
restaurantSchema.index({ status: 1, "rating.average": -1 });
restaurantSchema.index({ status: 1, createdAt: -1 });
restaurantSchema.index({ status: 1, cuisines: 1 });

export const Restaurant = mongoose.model("Restaurant", restaurantSchema);
