import mongoose from "mongoose";
import { emptyRating, ratingSummarySchema } from "./rating-summary.schema.js";

export const VEHICLE_TYPES = Object.freeze([
  "bicycle",
  "scooter",
  "motorbike",
  "car",
]);

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
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = String(ret._id);
        delete ret._id;
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
