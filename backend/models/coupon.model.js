import mongoose from "mongoose";

export const DISCOUNT_TYPES = Object.freeze({ PERCENT: "percent", FLAT: "flat" });

/**
 * Discount coupon. Eligibility (active, date window, minimum order,
 * restaurant, usage limits) is always checked on the server.
 */
const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, match: /^[A-Z0-9_-]{3,30}$/ },
    description: { type: String, trim: true, maxlength: 200 },
    discountType: { type: String, enum: Object.values(DISCOUNT_TYPES), required: true },
    // percent: 1-100; flat: integer paise
    discountValue: { type: Number, required: true, min: 1, validate: Number.isInteger },
    // Cap for percentage coupons (paise). Optional.
    maxDiscountPaise: { type: Number, min: 0, default: null, validate: (v) => v === null || Number.isInteger(v) },
    minOrderPaise: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    validFrom: { type: Date, required: true },
    validUntil: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
    // Total redemptions allowed across all customers (null = unlimited).
    usageLimit: { type: Number, min: 1, default: null },
    usedCount: { type: Number, default: 0, min: 0 },
    perUserLimit: { type: Number, min: 1, default: 1 },
    // Optional: only valid at one restaurant.
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: "Restaurant", default: null },
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

couponSchema.pre("validate", function checkCoupon() {
  if (this.discountType === DISCOUNT_TYPES.PERCENT && this.discountValue > 100) {
    this.invalidate("discountValue", "A percentage discount cannot exceed 100");
  }
  if (this.validFrom && this.validUntil && this.validUntil <= this.validFrom) {
    this.invalidate("validUntil", "End date must be after the start date");
  }
});

couponSchema.index({ code: 1 }, { unique: true });
couponSchema.index({ isActive: 1, validUntil: 1 });

export const Coupon = mongoose.model("Coupon", couponSchema);

/** One row per successful use; enforces per-user limits and gives an audit trail. */
const redemptionSchema = new mongoose.Schema(
  {
    coupon: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    discountPaise: { type: Number, required: true, min: 0 },
  },
  { timestamps: true },
);

redemptionSchema.index({ coupon: 1, user: 1 });
redemptionSchema.index({ order: 1 }, { unique: true });

export const CouponRedemption = mongoose.model("CouponRedemption", redemptionSchema);
