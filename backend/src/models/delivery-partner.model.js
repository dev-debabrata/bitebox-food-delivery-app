import mongoose from "mongoose";

export const VEHICLE_TYPES = Object.freeze(["bicycle", "scooter", "motorbike", "car"]);

const pointSchema = new mongoose.Schema(
  { type: { type: String, enum: ["Point"], default: "Point" }, coordinates: { type: [Number], required: true } },
  { _id: false },
);

/**
 * Delivery-partner profile: role-specific data for a User with role "delivery".
 *
 * `currentOffer` and `activeOrder` double as locks: a rider is offered at most
 * one order at a time and carries at most one, and both are only ever set with
 * conditional (compare-and-set) updates, so two orders can never grab the same
 * rider.
 */
const deliveryPartnerSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    vehicleType: { type: String, enum: VEHICLE_TYPES },
    vehicleNumber: { type: String, trim: true, uppercase: true, maxlength: 20 },

    isOnline: { type: Boolean, default: false },
    // Last reported position, for "nearest rider" dispatch. Live tracking comes in Phase 5.
    location: { type: pointSchema, default: undefined },
    locationUpdatedAt: { type: Date },
    // Reported GPS accuracy (metres) of that position.
    locationAccuracy: { type: Number, min: 0 },

    currentOffer: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    activeOrder: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    // Fairness tie-breaker: riders who have waited longest are offered first.
    lastAssignedAt: { type: Date, default: null },
    completedDeliveries: { type: Number, default: 0, min: 0 },
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
// Dispatch query: free, online riders near a point.
deliveryPartnerSchema.index({ location: "2dsphere" });
deliveryPartnerSchema.index({ isOnline: 1, activeOrder: 1, currentOffer: 1 });

export const DeliveryPartner = mongoose.model("DeliveryPartner", deliveryPartnerSchema);
