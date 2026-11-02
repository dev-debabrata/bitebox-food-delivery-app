import mongoose from "mongoose";

/**
 * Platform-wide food categories (e.g. "Biryani", "Pizza"), managed by admins.
 * Restaurants file each menu item under one of these, which powers both the
 * menu sections on a restaurant page and category browsing for customers.
 */
const foodCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 50 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, trim: true, maxlength: 300 },
    // Material Symbols icon name used by the web app (e.g. "local_pizza").
    icon: { type: String, trim: true, maxlength: 40, match: /^[a-z0-9_]+$/, default: "restaurant" },
    imageUrl: { type: String, trim: true, maxlength: 500 },
    sortOrder: { type: Number, default: 0, min: 0, max: 10_000 },
    isActive: { type: Boolean, default: true },
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

foodCategorySchema.index({ slug: 1 }, { unique: true });
foodCategorySchema.index({ isActive: 1, sortOrder: 1, name: 1 });

export const FoodCategory = mongoose.model("FoodCategory", foodCategorySchema);
