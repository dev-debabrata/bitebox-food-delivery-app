import mongoose from "mongoose";
import { FoodItem } from "../models/food-item.model.js";
import {
  ADMIN_STATUS_TRANSITIONS,
  RESTAURANT_STATUS,
  Restaurant,
} from "../models/restaurant.model.js";
import { ApiError } from "../utils/api-error.js";
import { PERMISSIONS } from "../config/permissions.js";
import { notify, notifyAdmins } from "./notification.service.js";
import { escapeRegex, paginationMeta } from "../utils/pagination.js";
import { toPoint } from "../utils/geo.js";
import { uniqueSlug } from "../utils/slug.js";
import { env } from "../config/env.js";
import { User } from "../models/user.model.js";
import * as kyc from "./kyc.service.js";

const OWNER_FIELDS = [
  "name",
  "description",
  "cuisines",
  "phone",
  "email",
  "address",
  "imageUrl",
  "isPureVeg",
  "costForTwoPaise",
  "minOrderPaise",
  "avgPrepTimeMinutes",
  "openingTime",
  "closingTime",
  "ownerName",
  "gstRegistered",
  "gstin",
  "fssaiNumber",
  "fssaiValidUntil",
  "photos",
  "weeklyHours",
];

const pick = (source, keys) =>
  Object.fromEntries(
    keys.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]),
  );

// Owner (restaurant partner)
export async function getOwnRestaurant(ownerId) {
  return Restaurant.findOne({ owner: ownerId });
}

/** Loads the caller's restaurant or fails with 404 (used by menu management). */
export async function requireOwnRestaurant(ownerId) {
  const restaurant = await getOwnRestaurant(ownerId);
  if (!restaurant)
    throw ApiError.notFound("Create your restaurant profile first");
  return restaurant;
}

/** An admin notification asking for a review of this restaurant. */
const reviewRequest = (restaurant, title, body) => ({
  type: "restaurant.review",
  title: `${title}: ${restaurant.name}`,
  body,
  link: `/admin/restaurants/${restaurant._id}`,
});

/** What the owner is told when an admin changes their restaurant's status. */
const STATUS_NOTICE = {
  [RESTAURANT_STATUS.APPROVED]: {
    title: "Your restaurant is live",
    body: "Customers can now find you and place orders.",
  },
  [RESTAURANT_STATUS.REJECTED]: {
    title: "Your application needs changes",
    body: "Update your details to send it for review again.",
  },
  [RESTAURANT_STATUS.SUSPENDED]: {
    title: "Your restaurant is suspended",
    body: "Customers cannot order until BiteBox reinstates it.",
  },
  [RESTAURANT_STATUS.RESUBMISSION_REQUESTED]: {
    title: "Please update your documents",
    body: "Fix what is asked on the Verification page, then send it for review again.",
  },
};
const NEEDS_REASON = [
  RESTAURANT_STATUS.REJECTED,
  RESTAURANT_STATUS.SUSPENDED,
  RESTAURANT_STATUS.RESUBMISSION_REQUESTED,
];

let kycOverride = null;
/** Tests: require verification before approval (true/false), or null for the configured behaviour. */
export const useRestaurantKyc = (value) => (kycOverride = value);

/** What stops approval: the FSSAI number, documents and the bank account (when required). */
export async function kycGaps(restaurant) {
  if (!(kycOverride ?? env.restaurantKycRequired)) return [];
  const owner = await User.findById(restaurant.owner._id ?? restaurant.owner);
  return [...(restaurant.fssaiNumber ? [] : ["FSSAI number"]), ...(await kyc.missing(owner))];
}

/** The owner fixed what was asked: back to the review queue. */
export async function resubmit(ownerId) {
  const restaurant = await requireOwnRestaurant(ownerId);
  if (![RESTAURANT_STATUS.REJECTED, RESTAURANT_STATUS.RESUBMISSION_REQUESTED].includes(restaurant.status))
    throw ApiError.conflict("Your restaurant is not waiting for changes");
  restaurant.status = RESTAURANT_STATUS.PENDING;
  restaurant.statusReason = undefined;
  const saved = await restaurant.save();
  await notifyAdmins(
    reviewRequest(saved, "Restaurant resubmitted", "The owner sent it for review again."),
    PERMISSIONS.RESTAURANTS_MANAGE,
  );
  return saved;
}

export async function createOwnRestaurant(ownerId, input) {
  if (await Restaurant.exists({ owner: ownerId })) {
    throw ApiError.conflict("You already have a restaurant. Edit it instead.");
  }
  const restaurant = await Restaurant.create({
    ...pick(input, OWNER_FIELDS),
    location: toPoint(input.location),
    owner: ownerId,
    slug: await uniqueSlug(Restaurant, input.name),
    status: RESTAURANT_STATUS.PENDING,
  });
  await notifyAdmins(
    reviewRequest(
      restaurant,
      "New restaurant application",
      "Review it to put it live on BiteBox.",
    ),
    PERMISSIONS.RESTAURANTS_MANAGE,
  );
  return restaurant;
}

export async function updateOwnRestaurant(ownerId, input) {
  const restaurant = await requireOwnRestaurant(ownerId);
  Object.assign(restaurant, pick(input, OWNER_FIELDS));
  if (input.location) restaurant.location = toPoint(input.location);
  if (input.name && input.name !== restaurant.name) {
    restaurant.slug = await uniqueSlug(Restaurant, input.name, restaurant._id);
  }
  // Fixing a rejected application sends it back for review.
  const resubmitted = restaurant.status === RESTAURANT_STATUS.REJECTED;
  if (resubmitted) {
    restaurant.status = RESTAURANT_STATUS.PENDING;
    restaurant.statusReason = undefined;
  }
  const saved = await restaurant.save();
  if (resubmitted)
    await notifyAdmins(
      reviewRequest(
        saved,
        "Restaurant resubmitted",
        "The owner updated a rejected application.",
      ),
      PERMISSIONS.RESTAURANTS_MANAGE,
    );
  return saved;
}

export async function setAcceptingOrders(ownerId, isAcceptingOrders) {
  const restaurant = await Restaurant.findOneAndUpdate(
    { owner: ownerId },
    { isAcceptingOrders },
    { returnDocument: "after" },
  );
  if (!restaurant)
    throw ApiError.notFound("Create your restaurant profile first");
  return restaurant;
}

export async function ownerStats(restaurantId) {
  const [total, available] = await Promise.all([
    FoodItem.countDocuments({ restaurant: restaurantId, deletedAt: null }),
    FoodItem.countDocuments({
      restaurant: restaurantId,
      deletedAt: null,
      isAvailable: true,
    }),
  ]);
  const categories = await FoodItem.distinct("category", {
    restaurant: restaurantId,
    deletedAt: null,
  });
  return {
    totalItems: total,
    availableItems: available,
    categoriesUsed: categories.length,
  };
}

// Admin
export async function adminList({ status, search }, pagination) {
  const filter = {};
  if (status) filter.status = status;
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: re }, { "address.city": re }, { cuisines: re }];
  }
  const [items, total] = await Promise.all([
    Restaurant.find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .populate("owner", "name email phone"),
    Restaurant.countDocuments(filter),
  ]);
  return { items, pagination: paginationMeta(pagination, total) };
}

export async function adminGet(id) {
  const restaurant = await Restaurant.findById(id).populate(
    "owner",
    "name email phone status",
  );
  if (!restaurant) throw ApiError.notFound("Restaurant not found");
  return restaurant;
}

export async function adminCounts() {
  const rows = await Restaurant.aggregate([
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(
    Object.values(RESTAURANT_STATUS).map((s) => [s, 0]),
  );
  for (const row of rows) counts[row._id] = row.count;
  return counts;
}

export async function adminSetStatus(id, nextStatus, reason, adminId) {
  const current = await Restaurant.findById(id).select("status");
  if (!current) throw ApiError.notFound("Restaurant not found");

  const allowed = ADMIN_STATUS_TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(nextStatus)) {
    throw ApiError.conflict(
      `Cannot change a ${current.status} restaurant to ${nextStatus}`,
    );
  }
  if (NEEDS_REASON.includes(nextStatus) && !reason) {
    throw ApiError.badRequest("A reason is required");
  }
  if (nextStatus === RESTAURANT_STATUS.APPROVED) {
    const gaps = await kycGaps(await Restaurant.findById(id));
    if (gaps.length)
      throw ApiError.conflict(`Finish the verification first: ${gaps.join(", ")}`, "KYC_INCOMPLETE");
  }

  const updated = await Restaurant.findOneAndUpdate(
    { _id: id, status: current.status },
    {
      status: nextStatus,
      statusReason: reason || undefined,
      reviewedAt: new Date(),
      reviewedBy: adminId,
    },
    { returnDocument: "after" },
  ).populate("owner", "name email phone status");

  if (!updated)
    throw ApiError.conflict(
      "This restaurant was updated by someone else. Refresh and try again.",
    );
  const notice = STATUS_NOTICE[nextStatus];
  if (notice) {
    await notify(updated.owner._id, {
      type: `restaurant.${nextStatus}`,
      title: notice.title,
      body: reason ? `${notice.body} Reason: ${reason}` : notice.body,
      link: nextStatus === RESTAURANT_STATUS.RESUBMISSION_REQUESTED ? "/restaurant/verification" : "/restaurant",
    });
  }
  return updated;
}

// Public discovery
const SORTS = {
  rating: { "rating.average": -1, "rating.count": -1, _id: 1 },
  fastest: { avgPrepTimeMinutes: 1, _id: 1 },
  costLow: { costForTwoPaise: 1, _id: 1 },
  costHigh: { costForTwoPaise: -1, _id: 1 },
  newest: { createdAt: -1, _id: 1 },
  distance: { distanceMeters: 1, _id: 1 },
};

export async function listPublic(query, pagination) {
  const match = { status: RESTAURANT_STATUS.APPROVED };

  if (query.search) {
    const re = new RegExp(escapeRegex(query.search), "i");
    // Also match restaurants that serve a dish with this name.
    const dishRestaurants = await FoodItem.distinct("restaurant", {
      name: re,
      deletedAt: null,
    });
    match.$or = [
      { name: re },
      { cuisines: re },
      { _id: { $in: dishRestaurants } },
    ];
  }
  if (query.cuisine)
    match.cuisines = new RegExp(`^${escapeRegex(query.cuisine)}$`, "i");
  if (query.veg) match.isPureVeg = true;
  if (query.category) {
    const ids = await FoodItem.distinct("restaurant", {
      category: new mongoose.Types.ObjectId(query.category),
      deletedAt: null,
      isAvailable: true,
    });
    match._id = { $in: ids };
  }

  const geo = query.lat !== undefined && query.lng !== undefined;
  const sortKey = query.sort ?? (geo ? "distance" : "rating");
  if (sortKey === "distance" && !geo)
    throw ApiError.badRequest("Sorting by distance needs lat and lng");

  const first = geo
    ? {
        $geoNear: {
          near: { type: "Point", coordinates: [query.lng, query.lat] },
          distanceField: "distanceMeters",
          maxDistance: (query.radiusKm ?? 15) * 1000,
          spherical: true,
          query: match,
        },
      }
    : { $match: match };

  const [result] = await Restaurant.aggregate([
    first,
    {
      $facet: {
        items: [
          { $sort: SORTS[sortKey] },
          { $skip: pagination.skip },
          { $limit: pagination.limit },
        ],
        total: [{ $count: "count" }],
      },
    },
  ]);

  const items = result.items.map((raw) => {
    const json = Restaurant.hydrate(raw).toJSON();
    return raw.distanceMeters === undefined
      ? json
      : { ...json, distanceMeters: Math.round(raw.distanceMeters) };
  });
  return {
    items: items.map(publicView),
    pagination: paginationMeta(pagination, result.total[0]?.count ?? 0),
  };
}

/** Distinct cuisines across approved restaurants (for filter dropdowns). */
export async function listCuisines() {
  const cuisines = await Restaurant.distinct("cuisines", {
    status: RESTAURANT_STATUS.APPROVED,
  });
  return [...new Set(cuisines.map((c) => c.trim()))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export async function getPublicBySlugOrId(slugOrId) {
  const filter = mongoose.isValidObjectId(slugOrId)
    ? { _id: slugOrId }
    : { slug: String(slugOrId).toLowerCase() };
  const restaurant = await Restaurant.findOne({
    ...filter,
    status: RESTAURANT_STATUS.APPROVED,
  });
  if (!restaurant) throw ApiError.notFound("Restaurant not found");
  return restaurant;
}

/** Removes internal/admin-only fields from a restaurant for public responses. */
export function publicView(restaurant) {
  const json =
    typeof restaurant.toJSON === "function" ? restaurant.toJSON() : restaurant;
  const {
    owner: _owner,
    statusReason: _reason,
    reviewedAt: _at,
    reviewedBy: _by,
    ownerName: _ownerName,
    gstRegistered: _gst,
    gstin: _gstin,
    fssaiValidUntil: _fssaiUntil,
    ...rest
  } = json;
  return rest;
}
