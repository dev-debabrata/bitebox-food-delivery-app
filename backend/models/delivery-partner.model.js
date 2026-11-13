import mongoose from "mongoose";
import { emptyRating, ratingSummarySchema } from "./rating-summary.schema.js";

export const VEHICLE_TYPES = Object.freeze([
  "bicycle",
  "scooter",
  "motorbike",
  "car",
]);

/** Rider verification (Django VerificationStatus). Riders go online only once approved. */
export const VERIFICATION_STATUS = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  RESUBMISSION_REQUESTED: "resubmission_requested", // "documents needed"
});
export const VERIFICATION_TRANSITIONS = Object.freeze({
  pending: ["approved", "rejected", "resubmission_requested"],
  resubmission_requested: ["approved", "rejected"],
  rejected: ["approved"],
  approved: ["resubmission_requested"], // e.g. a licence expired
});
/** Profiles from before verification existed have no status: they count as approved. */
export const verificationOf = (p) => p?.verificationStatus ?? VERIFICATION_STATUS.APPROVED;

const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], required: true },
  },
  { _id: false },
);

const deliveryPartnerSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    vehicleType: { type: String, enum: VEHICLE_TYPES },
    vehicleNumber: { type: String, trim: true, uppercase: true, maxlength: 20 },

    isOnline: { type: Boolean, default: false },
    location: { type: pointSchema, default: undefined },
    locationUpdatedAt: { type: Date },
    locationAccuracy: { type: Number, min: 0 },

    currentOffer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    activeOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    lastAssignedAt: { type: Date, default: null },
    completedDeliveries: { type: Number, default: 0, min: 0 },
    rating: { type: ratingSummarySchema, default: emptyRating },
    // Home address { line1, line2, area, city, state, postalCode }, for verification.
    address: { type: mongoose.Schema.Types.Mixed, default: undefined },
    // Set to "pending" when a profile is created (see getOrCreateProfile).
    verificationStatus: { type: String, enum: Object.values(VERIFICATION_STATUS) },
    verificationReason: { type: String, trim: true, maxlength: 500 },
    verifiedAt: { type: Date },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = String(ret._id);
        delete ret._id;
        ret.verification = {
          status: verificationOf(ret),
          reason: ret.verificationReason || null,
          verifiedAt: ret.verifiedAt ?? null,
        };
        delete ret.verificationStatus;
        delete ret.verificationReason;
        delete ret.verifiedAt;
        delete ret.verifiedBy;
        return ret;
      },
    },
  },
);

deliveryPartnerSchema.index({ user: 1 }, { unique: true });
deliveryPartnerSchema.index({ location: "2dsphere" });
deliveryPartnerSchema.index({ isOnline: 1, activeOrder: 1, currentOffer: 1 });

export const DeliveryPartner = mongoose.model(
  "DeliveryPartner",
  deliveryPartnerSchema,
);
