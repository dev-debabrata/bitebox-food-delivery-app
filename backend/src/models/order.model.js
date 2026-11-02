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

export const PAYMENT_METHODS = Object.freeze({ COD: "cod" });
export const PAYMENT_STATUS = Object.freeze({
  PENDING: "pending",
  PAID: "paid",
  FAILED: "failed",
  REFUNDED: "refunded",
  CANCELLED: "cancelled",
});

/**
 * OrderItem: a snapshot of the dish at checkout time. Later menu edits or
 * deletions never change what the customer ordered or paid.
 */
const orderItemSchema = new mongoose.Schema(
  {
    foodItem: { type: mongoose.Schema.Types.ObjectId, ref: "FoodItem", required: true },
    name: { type: String, required: true },
    isVeg: { type: Boolean, required: true },
    unitPricePaise: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    lineTotalPaise: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const pointSchema = new mongoose.Schema(
  { type: { type: String, enum: ["Point"], default: "Point" }, coordinates: { type: [Number], required: true } },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: "Restaurant", required: true },
    // Snapshot of restaurant identity for display even if it is later renamed.
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
    // Straight-line distance used for the delivery fee (not road distance).
    distanceMeters: { type: Number, required: true },
    note: { type: String, trim: true, maxlength: 300 },

    status: { type: String, enum: Object.values(ORDER_STATUS), default: ORDER_STATUS.PENDING },
    statusHistory: [
      {
        _id: false,
        status: { type: String, enum: Object.values(ORDER_STATUS), required: true },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        note: String,
      },
    ],

    // Payment status lives on the Payment document; this is a denormalised copy for listings.
    paymentMethod: { type: String, enum: Object.values(PAYMENT_METHODS), required: true },
    paymentStatus: { type: String, enum: Object.values(PAYMENT_STATUS), default: PAYMENT_STATUS.PENDING },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },

    // Client-supplied key so retries of the same checkout never create two orders.
    idempotencyKey: { type: String, maxlength: 100 },
    // The rider (User) carrying this order, set when they accept an offer.
    deliveryPartner: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // The rider currently being offered this order (while ready_for_pickup), and until when.
    offer: {
      partner: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      expiresAt: Date,
    },
    // Riders who declined or let an offer expire; they are not offered this order again.
    declinedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    // Why an order was rejected or cancelled, and by whom.
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
// Dispatch sweep: expired offers and ready orders without one.
orderSchema.index({ status: 1, "offer.expiresAt": 1 });
orderSchema.index(
  { customer: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
);

export const Order = mongoose.model("Order", orderSchema);

/** Payment record, separate from the order so payment and order status evolve independently. */
const paymentSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    method: { type: String, enum: Object.values(PAYMENT_METHODS), required: true },
    provider: { type: String, required: true },
    amountPaise: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "INR" },
    status: { type: String, enum: Object.values(PAYMENT_STATUS), default: PAYMENT_STATUS.PENDING },
    // Gateway transaction / order references (Phase 6).
    providerOrderId: String,
    providerPaymentId: String,
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

export const Payment = mongoose.model("Payment", paymentSchema);
