import mongoose from "mongoose";

export const MAX_ADDRESSES_PER_USER = 10;

const addressSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    label: { type: String, enum: ["home", "work", "other"], default: "home" },
    recipientName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 80,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      match: /^\+?[0-9]{10,15}$/,
    },
    line1: { type: String, required: true, trim: true, maxlength: 120 },
    line2: { type: String, trim: true, maxlength: 120 },
    area: { type: String, trim: true, maxlength: 80 },
    landmark: { type: String, trim: true, maxlength: 80 },
    city: { type: String, required: true, trim: true, maxlength: 60 },
    state: { type: String, required: true, trim: true, maxlength: 60 },
    postalCode: {
      type: String,
      required: true,
      trim: true,
      match: /^[A-Za-z0-9 -]{3,10}$/,
    },
    location: {
      type: { type: String, enum: ["Point"], default: "Point", required: true },
      // [longitude, latitude]
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
    isDefault: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.user;
        return ret;
      },
    },
  },
);

addressSchema.index({ user: 1, isDefault: -1, updatedAt: -1 });
addressSchema.index({ location: "2dsphere" });

export const Address = mongoose.model("Address", addressSchema);
