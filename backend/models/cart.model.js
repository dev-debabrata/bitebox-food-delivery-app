import mongoose from "mongoose";

export const MAX_CART_LINES = 30;
export const MAX_ITEM_QUANTITY = 20;

/**
 * One cart per customer, holding items from a single restaurant.
 * The cart stores only item ids and quantities - never prices. Prices are
 * always recalculated from the current menu when the cart is read.
 */
const cartItemSchema = new mongoose.Schema(
  {
    foodItem: { type: mongoose.Schema.Types.ObjectId, ref: "FoodItem", required: true },
    quantity: { type: Number, required: true, min: 1, max: MAX_ITEM_QUANTITY, validate: Number.isInteger },
  },
  { _id: false },
);

const cartSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: "Restaurant" },
    items: {
      type: [cartItemSchema],
      validate: { validator: (v) => v.length <= MAX_CART_LINES, message: `At most ${MAX_CART_LINES} different dishes` },
    },
    couponCode: { type: String, trim: true, uppercase: true, maxlength: 30 },
  },
  // Every save bumps __v and fails if someone else saved in between, so
  // concurrent edits (two tabs) cannot silently overwrite each other.
  { timestamps: true, optimisticConcurrency: true },
);

cartSchema.index({ user: 1 }, { unique: true });

export const Cart = mongoose.model("Cart", cartSchema);
