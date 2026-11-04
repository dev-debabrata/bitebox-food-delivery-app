import mongoose from "mongoose";

export const MAX_CART_LINES = 30;
export const MAX_ITEM_QUANTITY = 20;

const cartItemSchema = new mongoose.Schema(
  {
    foodItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FoodItem",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_ITEM_QUANTITY,
      validate: Number.isInteger,
    },
  },
  { _id: false },
);

const cartSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: "Restaurant" },
    items: {
      type: [cartItemSchema],
      validate: {
        validator: (v) => v.length <= MAX_CART_LINES,
        message: `At most ${MAX_CART_LINES} different dishes`,
      },
    },
    couponCode: { type: String, trim: true, uppercase: true, maxlength: 30 },
  },

  { timestamps: true, optimisticConcurrency: true },
);

cartSchema.index({ user: 1 }, { unique: true });

export const Cart = mongoose.model("Cart", cartSchema);
