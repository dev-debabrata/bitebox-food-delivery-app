import mongoose from "mongoose";

export const ORDER_STATUS = Object.freeze({
  PENDING: "pending",
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  PREPARING: "preparing",
  READY_FOR_PICKUP: "ready_for_pickup",
  ASSIGNED: "assigned",
  // The rider is at the restaurant counter (optional step before pickup).
  ARRIVED_AT_RESTAURANT: "arrived_at_restaurant",
  PICKED_UP: "picked_up",
  ON_THE_WAY: "on_the_way",
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
});

const S = ORDER_STATUS;
export const ACTIVE_STATUSES = Object.freeze([
  S.PENDING,
  S.CONFIRMED,
  S.PREPARING,
  S.READY_FOR_PICKUP,
  S.ASSIGNED,
  S.ARRIVED_AT_RESTAURANT,
  S.PICKED_UP,
  S.ON_THE_WAY,
]);
export const FINAL_STATUSES = Object.freeze([
  S.DELIVERED,
  S.REJECTED,
  S.CANCELLED,
]);
export const TRACKED_STATUSES = Object.freeze([
  S.ASSIGNED,
  S.ARRIVED_AT_RESTAURANT,
  S.PICKED_UP,
  S.ON_THE_WAY,
]);
/** Coins redeemed on an order: held at placement, spent once paid (cash: at once), given back if it closes. */
export const ORDER_COIN_STATES = Object.freeze({
  RESERVED: "reserved",
  COMMITTED: "committed",
  RELEASED: "released",
  REFUNDED: "refunded",
});
export const PAYMENT_METHODS = Object.freeze({ COD: "cod", ONLINE: "online" });
export const PAYMENT_STATUS = Object.freeze({
  PENDING: "pending",
  PAID: "paid",
  FAILED: "failed",
  REFUNDED: "refunded",
  PARTIALLY_REFUNDED: "partially_refunded",
  CANCELLED: "cancelled",
});

const orderItemSchema = new mongoose.Schema(
  {
    foodItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FoodItem",
      required: true,
    },
    name: { type: String, required: true },
    isVeg: { type: Boolean, required: true },
    unitPricePaise: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    lineTotalPaise: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], required: true },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
    },
    restaurantSnapshot: {
      name: { type: String, required: true },
      slug: String,
      phone: String,
      address: String,
      location: pointSchema,
    },
    items: { type: [orderItemSchema], validate: (v) => v.length > 0 },
    deliveryAddress: {
      label: String,
      recipientName: { type: String, required: true },
      phone: { type: String, required: true },
      line1: { type: String, required: true },
      line2: String,
      area: String,
      landmark: String,
      city: { type: String, required: true },
      state: String,
      postalCode: String,
      location: { type: pointSchema, required: true },
    },
    pricing: {
      subtotalPaise: { type: Number, required: true },
      discountPaise: { type: Number, default: 0 },
      deliveryFeePaise: { type: Number, required: true },
      platformFeePaise: { type: Number, required: true },
      taxPaise: { type: Number, required: true },
      // Paid with BiteBox coins (platform-funded; comes off the payable total, not the food value).
      coinDiscountPaise: { type: Number, default: 0, min: 0 },
      totalPaise: { type: Number, required: true },
    },
    coupon: { code: String, discountPaise: Number },
    coins: {
      redeemed: { type: Number, default: 0, min: 0 },
      discountPaise: { type: Number, default: 0, min: 0 },
      state: { type: String, enum: [...Object.values(ORDER_COIN_STATES), null], default: null },
      // Coins this order earned once delivered.
      earned: { type: Number, default: 0, min: 0 },
    },
    distanceMeters: { type: Number, required: true },
    note: { type: String, trim: true, maxlength: 300 },

    status: {
      type: String,
      enum: Object.values(ORDER_STATUS),
      default: ORDER_STATUS.PENDING,
    },
    statusHistory: [
      {
        _id: false,
        status: {
          type: String,
          enum: Object.values(ORDER_STATUS),
          required: true,
        },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        // Who made the move: customer, restaurant, delivery, admin or system (for the timeline).
        actor: String,
        note: String,
      },
    ],

    paymentMethod: {
      type: String,
      enum: Object.values(PAYMENT_METHODS),
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.PENDING,
    },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },

    submittedAt: { type: Date, default: null },
    // Set when the restaurant accepts: its preparation time and the expected ready time.
    prepMinutes: { type: Number, default: null },
    readyBy: { type: Date, default: null },
    // The 4-digit code made at pickup. Only the customer sees it; "delivered" needs it. Never in
    // toJSON: the presenters decide who gets what.
    deliveryOtp: { type: String, default: null },
    deliveryOtpAttempts: { type: Number, default: 0 },
    settlement: {
      restaurantPaise: Number,
      riderPaise: Number,
      platformPaise: Number,
      at: Date,
    },
    // The payout batch that paid each side of the settlement (null until finance pays it out).
    payouts: {
      restaurant: { type: mongoose.Schema.Types.ObjectId, ref: "Payout", default: null },
      rider: { type: mongoose.Schema.Types.ObjectId, ref: "Payout", default: null },
    },

    idempotencyKey: { type: String, maxlength: 100 },
    deliveryPartner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    offer: {
      partner: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      expiresAt: Date,
    },
    declinedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    cancellation: {
      by: { type: String, enum: ["customer", "restaurant", "admin", "system"] },
      reason: { type: String, trim: true, maxlength: 300 },
      at: Date,
    },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.idempotencyKey;
        delete ret.declinedBy;
        delete ret.deliveryOtp;
        delete ret.deliveryOtpAttempts;
        return ret;
      },
    },
  },
);

orderSchema.index({ orderNumber: 1 }, { unique: true });
orderSchema.index({ customer: 1, createdAt: -1 });
orderSchema.index({ restaurant: 1, status: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ deliveryPartner: 1, status: 1, createdAt: -1 });
orderSchema.index({ restaurant: 1, status: 1, "settlement.at": -1 });
orderSchema.index({ deliveryPartner: 1, "settlement.at": -1 });
orderSchema.index({ status: 1, "settlement.at": -1 });
orderSchema.index({ status: 1, "payouts.restaurant": 1, restaurant: 1 });
orderSchema.index({ status: 1, "payouts.rider": 1, deliveryPartner: 1 });
orderSchema.index({ status: 1, "offer.expiresAt": 1 });
orderSchema.index(
  { "coins.state": 1, status: 1 },
  { partialFilterExpression: { "coins.state": "reserved" } },
);
orderSchema.index(
  { customer: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  },
);

export const Order = mongoose.model("Order", orderSchema);

const paymentSchema = new mongoose.Schema(
  {
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    method: {
      type: String,
      enum: Object.values(PAYMENT_METHODS),
      required: true,
    },
    provider: {
      type: String,
      enum: ["cash_on_delivery", "razorpay", "mock"],
      required: true,
    },
    amountPaise: { type: Number, required: true, min: 0 },
    // Refunded so far, counting refunds still under way (services/payments: reserved when a
    // refund opens, so two refunds can never return more than was paid).
    refundedPaise: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "INR" },
    status: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.PENDING,
    },
    providerOrderId: String,
    providerPaymentId: String,
    failureReason: String,
    paidAt: Date,
    refundedAt: Date,
    providerRefundId: String,
    processedEvents: { type: [String], default: [], select: false },
    // The gateway events applied to this payment (ids, types, times only), for the audit trail.
    events: {
      type: [{ _id: false, eventId: String, type: { type: String }, at: Date }],
      default: [],
    },
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

paymentSchema.index({ order: 1 }, { unique: true });
paymentSchema.index({ user: 1, createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });
paymentSchema.index({ provider: 1, providerOrderId: 1 }, { sparse: true });

export const Payment = mongoose.model("Payment", paymentSchema);
