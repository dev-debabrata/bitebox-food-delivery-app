import { FoodCategory } from "../models/food-category.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { ApiError } from "../utils/api-error.js";
import { escapeRegex } from "../utils/pagination.js";
import { uniqueSlug } from "../utils/slug.js";

const FIELDS = [
  "name",
  "description",
  "icon",
  "imageUrl",
  "sortOrder",
  "isActive",
];
const pick = (source) =>
  Object.fromEntries(
    FIELDS.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]),
  );

const ORDER = { sortOrder: 1, name: 1 };

async function assertUniqueName(name, excludeId) {
  const clash = await FoodCategory.exists({
    name: new RegExp(`^${escapeRegex(name.trim())}$`, "i"),
    ...(excludeId && { _id: { $ne: excludeId } }),
  });
  if (clash)
    throw ApiError.conflict("A category with this name already exists");
}

export const listActive = () =>
  FoodCategory.find({ isActive: true }).sort(ORDER);

/** All categories with how many live menu items use each. */
export async function adminList() {
  const [categories, counts] = await Promise.all([
    FoodCategory.find().sort(ORDER),
    FoodItem.aggregate([
      { $match: { deletedAt: null } },
      { $group: { _id: "$category", count: { $sum: 1 } } },
    ]),
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c.count]));
  return categories.map((c) => ({
    ...c.toJSON(),
    itemCount: byId.get(String(c._id)) ?? 0,
  }));
}

export async function create(input) {
  await assertUniqueName(input.name);
  return FoodCategory.create({
    ...pick(input),
    slug: await uniqueSlug(FoodCategory, input.name),
  });
}

export async function update(id, input) {
  const category = await FoodCategory.findById(id);
  if (!category) throw ApiError.notFound("Category not found");
  if (input.name && input.name !== category.name) {
    await assertUniqueName(input.name, category._id);
    category.slug = await uniqueSlug(FoodCategory, input.name, category._id);
  }
  Object.assign(category, pick(input));
  return category.save();
}

/** Only unused categories can be deleted; otherwise deactivate them. */
export async function remove(id) {
  if (await FoodItem.exists({ category: id, deletedAt: null })) {
    throw ApiError.conflict(
      "This category is used by menu items. Deactivate it instead.",
    );
  }
  const deleted = await FoodCategory.findByIdAndDelete(id);
  if (!deleted) throw ApiError.notFound("Category not found");
}
