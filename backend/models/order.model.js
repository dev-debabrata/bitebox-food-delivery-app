import mongoose from "mongoose";

export const ORDER_STATUS = Object.freeze({
  PENDING: "pending",
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  PREPARING: "preparing",
  READY_FOR_PICKUP: "ready_for_pickup",
  ASSIGNED: "assigned",
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
  S.PICKED_UP,
  S.ON_THE_WAY,
]);
export const PAYMENT_METHODS = Object.freeze({ COD: "cod", ONLINE: "online" });
export const PAYMENT_STATUS = Object.freeze({
  PENDING: "pending",
  PAID: "paid",
  FAILED: "failed",
  REFUNDED: "refunded",
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
      totalPaise: { type: Number, required: true },
    },
    coupon: { code: String, discountPaise: Number },
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
    settlement: {
      restaurantPaise: Number,
      riderPaise: Number,
      platformPaise: Number,
      at: Date,
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
orderSchema.index({ status: 1, "offer.expiresAt": 1 });
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
