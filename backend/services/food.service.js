import mongoose from "mongoose";
import { FoodCategory } from "../models/food-category.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { RESTAURANT_STATUS, Restaurant } from "../models/restaurant.model.js";
import { ApiError } from "../utils/api-error.js";
import { escapeRegex, paginationMeta } from "../utils/pagination.js";

const EDITABLE = ["name", "description", "category", "pricePaise", "isVeg", "isAvailable", "imageUrl", "prepTimeMinutes", "tags"];
const pick = (source) => Object.fromEntries(EDITABLE.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]));

async function assertActiveCategory(categoryId) {
  if (!(await FoodCategory.exists({ _id: categoryId, isActive: true }))) {
    throw new ApiError(422, "Validation failed", {
      code: "VALIDATION_ERROR",
      details: [{ field: "category", message: "Choose an active category" }],
    });
  }
}

async function assertUniqueName(restaurantId, name, excludeId) {
  const clash = await FoodItem.exists({
    restaurant: restaurantId,
    deletedAt: null,
    name: new RegExp(`^${escapeRegex(name.trim())}$`, "i"),
    ...(excludeId && { _id: { $ne: excludeId } }),
  });
  if (clash) throw ApiError.conflict("Your menu already has an item with this name");
}

function listFilter(base, { search, category, available, veg }) {
  const filter = { ...base, deletedAt: null };
  if (search) filter.name = new RegExp(escapeRegex(search), "i");
  if (category) filter.category = category;
  if (available !== undefined) filter.isAvailable = available;
  if (veg) filter.isVeg = true;
  return filter;
}

// ---------------------------------------------------------------------------
// Restaurant owner: every query is scoped to the owner's own restaurant id,
// so one restaurant can never read or modify another's items.
// ---------------------------------------------------------------------------

export async function ownerList(restaurantId, query, pagination) {
  const filter = listFilter({ restaurant: restaurantId }, query);
  const [items, total] = await Promise.all([
    FoodItem.find(filter)
      .sort({ category: 1, name: 1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .populate("category", "name slug icon"),
    FoodItem.countDocuments(filter),
  ]);
  return { items, pagination: paginationMeta(pagination, total) };
}

export async function ownerCreate(restaurantId, input) {
  await assertActiveCategory(input.category);
  await assertUniqueName(restaurantId, input.name);
  const item = await FoodItem.create({ ...pick(input), restaurant: restaurantId });
  return item.populate("category", "name slug icon");
}

async function ownerFind(restaurantId, itemId) {
  const item = await FoodItem.findOne({ _id: itemId, restaurant: restaurantId, deletedAt: null });
  // 404 (not 403) so other restaurants' item ids are not revealed.
  if (!item) throw ApiError.notFound("Menu item not found");
  return item;
}

export async function ownerUpdate(restaurantId, itemId, input) {
  const item = await ownerFind(restaurantId, itemId);
  if (input.category && String(input.category) !== String(item.category)) await assertActiveCategory(input.category);
  if (input.name) await assertUniqueName(restaurantId, input.name, item._id);
  Object.assign(item, pick(input));
  await item.save();
  return item.populate("category", "name slug icon");
}

export async function ownerSetAvailability(restaurantId, itemId, isAvailable) {
  const item = await FoodItem.findOneAndUpdate(
    { _id: itemId, restaurant: restaurantId, deletedAt: null },
    { isAvailable },
    { returnDocument: "after" },
  ).populate("category", "name slug icon");
  if (!item) throw ApiError.notFound("Menu item not found");
  return item;
}

export async function ownerDelete(restaurantId, itemId) {
  const item = await FoodItem.findOneAndUpdate(
    { _id: itemId, restaurant: restaurantId, deletedAt: null },
    { deletedAt: new Date(), isAvailable: false },
  );
  if (!item) throw ApiError.notFound("Menu item not found");
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export async function adminList(query, pagination) {
  const filter = listFilter(query.restaurant ? { restaurant: query.restaurant } : {}, query);
  const [items, total] = await Promise.all([
    FoodItem.find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .populate("category", "name slug icon")
      .populate("restaurant", "name slug status"),
    FoodItem.countDocuments(filter),
  ]);
  return { items, pagination: paginationMeta(pagination, total) };
}

export async function adminSetAvailability(itemId, isAvailable) {
  const item = await FoodItem.findOneAndUpdate({ _id: itemId, deletedAt: null }, { isAvailable }, { returnDocument: "after" })
    .populate("category", "name slug icon")
    .populate("restaurant", "name slug status");
  if (!item) throw ApiError.notFound("Menu item not found");
  return item;
}

export async function adminDelete(itemId) {
  const item = await FoodItem.findOneAndUpdate({ _id: itemId, deletedAt: null }, { deletedAt: new Date(), isAvailable: false });
  if (!item) throw ApiError.notFound("Menu item not found");
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/** Full menu of an approved restaurant, grouped by category (unavailable items included and flagged). */
export async function publicMenu(restaurantId) {
  const items = await FoodItem.find({ restaurant: restaurantId, deletedAt: null })
    .sort({ name: 1 })
    .populate("category", "name slug icon sortOrder");

  const groups = new Map();
  for (const item of items) {
    const category = item.category;
    const key = String(category?._id ?? "other");
    if (!groups.has(key)) {
      groups.set(key, {
        category: category ? { id: key, name: category.name, slug: category.slug, icon: category.icon } : null,
        sortOrder: category?.sortOrder ?? 9999,
        items: [],
      });
    }
    groups.get(key).items.push(item.toJSON());
  }
  return [...groups.values()]
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.category?.name ?? "").localeCompare(b.category?.name ?? ""))
    .map(({ category, items: groupItems }) => ({ category, items: groupItems }));
}

const RESTAURANT_SUMMARY = { _id: 1, name: 1, slug: 1, cuisines: 1, rating: 1, avgPrepTimeMinutes: 1, imageUrl: 1, address: 1 };

/** Dish search across all approved restaurants. */
export async function publicSearch({ search, category, veg }, pagination) {
  const filter = { deletedAt: null, isAvailable: true };
  if (search) filter.name = new RegExp(escapeRegex(search), "i");
  if (category) filter.category = new mongoose.Types.ObjectId(category);
  if (veg) filter.isVeg = true;

  const [result] = await FoodItem.aggregate([
    { $match: filter },
    {
      $lookup: {
        from: Restaurant.collection.name,
        localField: "restaurant",
        foreignField: "_id",
        as: "restaurant",
        pipeline: [{ $match: { status: RESTAURANT_STATUS.APPROVED } }, { $project: RESTAURANT_SUMMARY }],
      },
    },
    { $unwind: "$restaurant" },
    {
      $lookup: {
        from: FoodCategory.collection.name,
        localField: "category",
        foreignField: "_id",
        as: "category",
        pipeline: [{ $project: { name: 1, slug: 1, icon: 1 } }],
      },
    },
    { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
    {
      $facet: {
        items: [{ $sort: { "restaurant.rating.average": -1, name: 1, _id: 1 } }, { $skip: pagination.skip }, { $limit: pagination.limit }],
        total: [{ $count: "count" }],
      },
    },
  ]);

  const items = result.items.map(({ _id, __v: _v, deletedAt: _d, restaurant, category: cat, ...rest }) => ({
    id: String(_id),
    ...rest,
    category: cat ? { id: String(cat._id), name: cat.name, slug: cat.slug, icon: cat.icon } : null,
    restaurant: {
      id: String(restaurant._id),
      name: restaurant.name,
      slug: restaurant.slug,
      cuisines: restaurant.cuisines,
      rating: restaurant.rating,
      imageUrl: restaurant.imageUrl,
      city: restaurant.address?.city,
      avgPrepTimeMinutes: restaurant.avgPrepTimeMinutes,
    },
  }));
  return { items, pagination: paginationMeta(pagination, result.total[0]?.count ?? 0) };
}

/** A single dish with its (approved) restaurant. */
export async function publicGet(itemId) {
  const item = await FoodItem.findOne({ _id: itemId, deletedAt: null })
    .populate("category", "name slug icon")
    .populate({ path: "restaurant", match: { status: RESTAURANT_STATUS.APPROVED }, select: "name slug cuisines rating imageUrl isAcceptingOrders openingTime closingTime timezone" });
  if (!item || !item.restaurant) throw ApiError.notFound("Dish not found");
  const json = item.toJSON();
  json.restaurant = { ...json.restaurant, isOpenNow: item.restaurant.isOpenNow };
  return json;
}
