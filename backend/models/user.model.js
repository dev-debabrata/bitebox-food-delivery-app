import mongoose from "mongoose";
import {
  ADMIN_ROLES,
  ALL_ROLES,
  MEMBER_ROLES,
  ROLES,
  STAFF_ADMIN_ROLES,
} from "../config/roles.js";
import { permissionsFor } from "../config/permissions.js";

export { ADMIN_ROLES, ALL_ROLES, MEMBER_ROLES, ROLES, STAFF_ADMIN_ROLES };

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

    // Customers: their own invite code (BITEBOX-NAME7K2Q), made on sign-up or first use.
    referralCode: { type: String, trim: true, uppercase: true, maxlength: 40 },
    // Customers: date of birth (UTC midnight of the day) for birthday rewards. Set once.
    birthDate: { type: Date, default: undefined },

    // Which notifications may be pushed to this person's devices. The in-app inbox always
    // records them; these switches only decide what also arrives as a browser push.
    pushPreferences: {
      orders: { type: Boolean, default: true }, // order and delivery updates
      account: { type: Boolean, default: true }, // support, reviews, coins, panel alerts
      promotions: { type: Boolean, default: false }, // offers: opt-in only
    },
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
        delete ret.pushPreferences; // served by GET /push/preferences
        // Admin roles carry their permissions so the web app can shape its menu (the API still checks).
        if (ADMIN_ROLES.includes(ret.role)) ret.permissions = permissionsFor(ret.role);
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
userSchema.index(
  { referralCode: 1 },
  { unique: true, partialFilterExpression: { referralCode: { $type: "string" } } },
);
userSchema.index({ passwordResetTokenHash: 1 }, { sparse: true });

export const User = mongoose.model("User", userSchema);
