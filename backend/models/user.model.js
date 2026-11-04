import mongoose from "mongoose";

export const ROLES = Object.freeze({
  CUSTOMER: "customer",
  ADMIN: "admin",
  RESTAURANT: "restaurant",
  DELIVERY: "delivery",
});

export const ALL_ROLES = Object.values(ROLES);

export const SELF_REGISTER_ROLES = [
  ROLES.CUSTOMER,
  ROLES.RESTAURANT,
  ROLES.DELIVERY,
];

export const USER_STATUS = Object.freeze({
  ACTIVE: "active",
  SUSPENDED: "suspended",
});

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 80,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email address"],
    },
    phone: {
      type: String,
      trim: true,
      match: [/^\+?[0-9]{10,15}$/, "Invalid phone number"],
    },
    role: {
      type: String,
      enum: ALL_ROLES,
      required: true,
      default: ROLES.CUSTOMER,
    },
    status: {
      type: String,
      enum: Object.values(USER_STATUS),
      default: USER_STATUS.ACTIVE,
    },

    passwordHash: { type: String, required: true, select: false },
    tokenVersion: { type: Number, default: 0, select: false },

    passwordResetTokenHash: { type: String, select: false },
    passwordResetExpiresAt: { type: Date, select: false },

    lastLoginAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.passwordHash;
        delete ret.tokenVersion;
        delete ret.passwordResetTokenHash;
        delete ret.passwordResetExpiresAt;
        return ret;
      },
    },
  },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: "string" } } },
);
userSchema.index({ role: 1, status: 1, createdAt: -1 });
userSchema.index({ passwordResetTokenHash: 1 }, { sparse: true });

export const User = mongoose.model("User", userSchema);
