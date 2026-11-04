import mongoose from "mongoose";

/**
 * A dish on a restaurant's menu. Items are soft-deleted (deletedAt) so that
 * historical references stay valid; orders will additionally snapshot the
 * name and price at checkout time (Phase 3).
 */
const foodItemSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: "Restaurant", required: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: "FoodCategory", required: true },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 500 },
    // Integer paise (₹1 = 100 paise).
    pricePaise: {
      type: Number,
      required: true,
      min: 100,
      max: 10_000_000,
      validate: { validator: Number.isInteger, message: "Price must be a whole number of paise" },
    },
    isVeg: { type: Boolean, required: true },
    isAvailable: { type: Boolean, default: true },
    imageUrl: { type: String, trim: true, maxlength: 500 },
    prepTimeMinutes: { type: Number, min: 1, max: 180 },
    tags: {
      type: [{ type: String, trim: true, lowercase: true, maxlength: 30 }],
      validate: { validator: (v) => v.length <= 10, message: "At most 10 tags" },
    },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.deletedAt;
        return ret;
      },
    },
  },
);

foodItemSchema.index({ restaurant: 1, deletedAt: 1, category: 1 });
foodItemSchema.index({ category: 1, deletedAt: 1, isAvailable: 1 });
foodItemSchema.index({ deletedAt: 1, isAvailable: 1, createdAt: -1 });

export const FoodItem = mongoose.model("FoodItem", foodItemSchema);
