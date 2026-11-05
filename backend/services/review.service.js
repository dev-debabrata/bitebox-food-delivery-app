import { PERMISSIONS } from "../config/permissions.js";
import mongoose from "mongoose";
import { REVIEW_POLICY } from "../config/reviews.js";
import { DeliveryPartner } from "../models/delivery-partner.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { ORDER_STATUS, Order } from "../models/order.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import {
  REPORT_STATUS,
  REVIEW_STATUS,
  REVIEW_TARGETS,
  Review,
  ReviewReport,
} from "../models/review.model.js";
import { emptyRating } from "../models/rating-summary.schema.js";
import { ROLES } from "../models/user.model.js";
import { ApiError } from "../utils/api-error.js";
import { paginationMeta } from "../utils/pagination.js";
import * as rewardEvents from "./reward-events.js";
import {
  notify,
  notifyAdmins,
  restaurantOwner,
} from "./notification.service.js";

const T = REVIEW_TARGETS;
const DAY_MS = 86_400_000;
export const toId = (id) => new mongoose.Types.ObjectId(String(id));

/** Full name of the customer ("Asha Customer"). */
export function shortName(name = "") {
  return name.trim() || "Customer";
}

// Rating summaries
const SUBJECTS = {
  [T.RESTAURANT]: { field: "restaurant", model: Restaurant, key: "_id" },
  [T.FOOD]: { field: "foodItem", model: FoodItem, key: "_id" },
  [T.RIDER]: {
    field: "deliveryPartner",
    model: DeliveryPartner,
    key: "user",
  },
};

/** `{ rating, n }` rows -> average (2 decimals), count and the 1-5 star distribution. */
export function summarize(rows) {
  const distribution = [0, 0, 0, 0, 0];
  for (const r of rows) distribution[r.rating - 1] += r.n;
  const count = distribution.reduce((a, b) => a + b, 0);
  const total = distribution.reduce((a, n, i) => a + n * (i + 1), 0);
  return {
    average: count ? Math.round((total / count) * 100) / 100 : 0,
    count,
    distribution,
  };
}

/** Average, count and 1-5 star distribution of the published reviews of one subject. */
async function ratingSummary(target, subjectId) {
  const { field } = SUBJECTS[target];
  const rows = await Review.aggregate([
    {
      $match: {
        target,
        [field]: toId(subjectId),
        status: REVIEW_STATUS.PUBLISHED,
      },
    },
    { $group: { _id: "$rating", n: { $sum: 1 } } },
  ]);
  return summarize(rows.map((r) => ({ rating: r._id, n: r.n })));
}

/**
 * Rebuilds the cached summary from the reviews themselves (not by adding deltas), so it cannot
 * drift: every create, edit, delete and moderation action calls this, and any later call repairs
 * an earlier one that lost a race.
 */
export async function refreshRating(target, subjectId) {
  if (!subjectId) return null;
  const { model, key } = SUBJECTS[target];
  const rating = await ratingSummary(target, subjectId);
  await model.updateOne({ [key]: subjectId }, { $set: { rating } });
  return rating;
}

export const refreshFor = (review) =>
  refreshRating(review.target, review[SUBJECTS[review.target].field]);

// Presenters
const responseView = (review) =>
  review.response?.text
    ? {
        text: review.response.text,
        respondedAt: review.response.respondedAt,
        updatedAt: review.response.updatedAt,
      }
    : null;

/** What anyone may see: no customer id, order or contact details. */
export function presentPublic(review) {
  return {
    id: String(review._id),
    target: review.target,
    rating: review.rating,
    comment: review.comment,
    authorName: shortName(review.customerName),
    foodItem: review.foodItem ? String(review.foodItem) : null,
    foodName: review.foodName ?? null,
    images: review.images ?? [],
    verifiedOrder: true,
    response: responseView(review),
    createdAt: review.createdAt,
    editedAt: review.editedAt,
  };
}

/** The author's own view, including why a review was hidden or removed. */
export function presentForCustomer(review) {
  return {
    ...presentPublic(review),
    status: review.status,
    order: String(review.order),
    orderNumber: review.orderNumber,
    restaurant: String(review.restaurant?._id ?? review.restaurant),
    deliveryPartner: review.deliveryPartner
      ? String(review.deliveryPartner)
      : null,
    moderation:
      review.status === REVIEW_STATUS.HIDDEN ||
      review.status === REVIEW_STATUS.REMOVED
        ? { action: review.moderation?.action, reason: review.moderation?.reason }
        : null,
    editableUntil: editableUntil(review),
  };
}

function presentForRestaurant(review, reportedIds) {
  return {
    ...presentPublic(review),
    orderNumber: review.orderNumber,
    reportedByYou: reportedIds.has(String(review._id)),
  };
}

/** Riders see the rating and words, the author's first name and the order number. Nothing else. */
function presentForRider(review, reportedIds) {
  return {
    id: String(review._id),
    rating: review.rating,
    comment: review.comment,
    authorName: shortName(review.customerName),
    orderNumber: review.orderNumber,
    createdAt: review.createdAt,
    editedAt: review.editedAt,
    reportedByYou: reportedIds.has(String(review._id)),
  };
}

const editableUntil = (review) =>
  review.status === REVIEW_STATUS.PUBLISHED
    ? new Date(
        review.createdAt.getTime() + REVIEW_POLICY.editWindowDays * DAY_MS,
      )
    : null;

const SORTS = {
  newest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  highest: { rating: -1, createdAt: -1, _id: -1 },
  lowest: { rating: 1, createdAt: -1, _id: -1 },
};

async function page(filter, { sort = "newest" }, pagination, populate) {
  let find = Review.find(filter)
    .sort(SORTS[sort] ?? SORTS.newest)
    .skip(pagination.skip)
    .limit(pagination.limit);
  if (populate) find = find.populate(populate);
  const [items, total] = await Promise.all([
    find,
    Review.countDocuments(filter),
  ]);
  return { items, pagination: paginationMeta(pagination, total) };
}

async function reportedBy(userId, reviews) {
  const ids = await ReviewReport.find({
    reporter: userId,
    review: { $in: reviews.map((r) => r._id) },
  }).distinct("review");
  return new Set(ids.map(String));
}

export const reviewChanged = () =>
  new ApiError(409, "This review just changed. Reload and try again.", {
    code: "REVIEW_CHANGED",
  });

const sameSubject = (r, target, foodItem = null) =>
  r.target === target && String(r.foodItem ?? "") === String(foodItem ?? "");

// Eligibility
const deliveredAt = (order) =>
  order.statusHistory.findLast((h) => h.status === ORDER_STATUS.DELIVERED)
    ?.at ??
  order.settlement?.at ??
  order.updatedAt;

/** Loaded from the database with the customer as part of the filter: never trust the client. */
async function ownOrder(customerId, orderId) {
  const order = await Order.findOne({ _id: orderId, customer: customerId });
  if (!order) throw ApiError.notFound("Order not found");
  return order;
}

function reviewWindow(order, now = new Date()) {
  if (order.status !== ORDER_STATUS.DELIVERED)
    return {
      open: false,
      closesAt: null,
      code: "ORDER_NOT_DELIVERED",
      reason: "You can review an order once it has been delivered",
    };
  const closesAt = new Date(
    deliveredAt(order).getTime() + REVIEW_POLICY.submitWindowDays * DAY_MS,
  );
  if (now > closesAt)
    return {
      open: false,
      closesAt,
      code: "REVIEW_WINDOW_CLOSED",
      reason: `Reviews can be written up to ${REVIEW_POLICY.submitWindowDays} days after delivery`,
    };
  return { open: true, closesAt };
}

// Customer
function assertOpen(order) {
  const window = reviewWindow(order);
  if (!window.open)
    throw new ApiError(409, window.reason, { code: window.code });
}

/** What can be reviewed on the order and what this customer already did. */
function orderState(order, reviews) {
  const window = reviewWindow(order);
  const find = (target, foodItem) => {
    const r = reviews.find((x) => sameSubject(x, target, foodItem));
    return r ? presentForCustomer(r) : null;
  };
  return {
    orderId: String(order._id),
    canReview: window.open,
    reason: window.reason ?? null,
    closesAt: window.closesAt,
    restaurant: {
      id: String(order.restaurant),
      name: order.restaurantSnapshot.name,
      review: find(T.RESTAURANT),
    },
    items: order.items.map((i) => ({
      foodItem: String(i.foodItem),
      name: i.name,
      review: find(T.FOOD, i.foodItem),
    })),
    rider: order.deliveryPartner ? { review: find(T.RIDER) } : null,
  };
}

const ordersReviews = (order, customerId) =>
  order.status === ORDER_STATUS.DELIVERED
    ? Review.find({ order: order._id, customer: customerId })
    : [];

/** Everything the "Rate your order" dialog needs: what can be reviewed and what already was. */
export async function orderReviews(customerId, orderId) {
  const order = await ownOrder(customerId, orderId);
  return orderState(order, await ordersReviews(order, customerId));
}

/** The review document for one part of an (already loaded and checked) order. */
function buildReview(user, order, { target, foodItemId, rating, comment, images }) {
  const doc = {
    target,
    customer: user._id,
    customerName: user.name,
    order: order._id,
    orderNumber: order.orderNumber,
    restaurant: order.restaurant,
    rating,
    comment: comment ?? "",
    images: images ?? [],
  };
  if (target === T.FOOD) {
    const line = order.items.find((i) => String(i.foodItem) === foodItemId);
    if (!line)
      throw new ApiError(422, "That dish was not part of this order", {
        code: "VALIDATION_ERROR",
        details: [{ field: "foodItemId", message: "Not in this order" }],
      });
    doc.foodItem = line.foodItem;
    doc.foodName = line.name;
  }
  if (target === T.RIDER) {
    if (!order.deliveryPartner)
      throw new ApiError(409, "This order had no delivery partner", {
        code: "NO_RIDER",
      });
    doc.deliveryPartner = order.deliveryPartner;
  }
  return doc;
}

async function insertReview(doc) {
  try {
    return await Review.create(doc);
  } catch (error) {
    if (error.code === 11000)
      throw new ApiError(409, "You have already reviewed this", {
        code: "DUPLICATE_REVIEW",
      });
    throw error;
  }
}

export async function create(user, input) {
  const order = await ownOrder(user._id, input.orderId);
  assertOpen(order);
  const review = await insertReview(buildReview(user, order, input));
  await Promise.all([refreshFor(review), notifyNewReview(review)]);
  return presentForCustomer(review);
}

/** Restaurant, rider: one part each. Food: every dish not yet rated. */
const ORDER_PARTS = [
  ["restaurant", T.RESTAURANT, "You have already rated the restaurant"],
  ["food", T.FOOD, "You have already rated every dish"],
  ["rider", T.RIDER, "You have already rated the delivery"],
];

/**
 * "Rate your experience" in one go: the restaurant (with the words and photos), every dish not yet
 * rated (food quality) and the rider. All or nothing: a failure removes what this call created.
 */
export async function reviewOrder(user, orderId, input) {
  const order = await ownOrder(user._id, orderId);
  assertOpen(order);
  const existing = await Review.find({ order: order._id }).select("target foodItem");
  const done = (target, foodItem) => existing.some((r) => sameSubject(r, target, foodItem));

  const parts = [];
  for (const [key, target, message] of ORDER_PARTS) {
    const rating = input[key];
    if (rating === undefined) continue;
    const subjects =
      target === T.FOOD
        ? order.items.filter((i) => !done(T.FOOD, i.foodItem)).map((i) => String(i.foodItem))
        : done(target) ? [] : [undefined];
    if (!subjects.length)
      throw new ApiError(409, message, { code: "DUPLICATE_REVIEW" });
    for (const foodItemId of subjects)
      parts.push({
        target,
        foodItemId,
        rating,
        ...(target === T.RESTAURANT && { comment: input.comment, images: input.images }),
      });
  }

  const docs = parts.map((part) => buildReview(user, order, part));
  const results = await Promise.allSettled(docs.map(insertReview));
  const created = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) {
    // Undo this call's reviews (hard delete: they were never seen).
    await Review.deleteMany({ _id: { $in: created.map((r) => r._id) } });
    throw failed.reason;
  }

  await rewardEvents.reviewsPosted(order, created);

  // Each created review is a different subject, so each refresh is needed once.
  // One notification per party, not one per dish.
  const forRestaurant = created.find((r) => r.target !== T.RIDER);
  const forRider = created.find((r) => r.target === T.RIDER);
  await Promise.all([
    ...created.map(refreshFor),
    forRestaurant &&
      notifyNewReview(
        forRestaurant,
        input.restaurant !== undefined
          ? `New ${input.restaurant}★ review`
          : `New ${input.food}★ food rating`,
      ),
    forRider && notifyNewReview(forRider),
  ]);
  return orderState(order, await ordersReviews(order, user._id));
}

async function notifyNewReview(review, title) {
  const rider = review.target === T.RIDER;
  await notify(
    rider ? review.deliveryPartner : await restaurantOwner(review.restaurant),
    {
      type: "review.new",
      title: title ?? `New ${review.rating}★ ${rider ? "delivery rating" : "review"}`,
      body:
        review.target === T.FOOD && !title
          ? `${review.foodName}, order ${review.orderNumber}`
          : `Order ${review.orderNumber}`,
      link: rider ? "/delivery/reviews" : "/restaurant/reviews",
    },
  );
}

export async function listMine(customerId, query, pagination) {
  const filter = {
    customer: customerId,
    status: { $ne: REVIEW_STATUS.DELETED },
    ...(query.target && { target: query.target }),
  };
  const result = await page(filter, query, pagination, {
    path: "restaurant",
    select: "name slug",
  });
  return {
    items: result.items.map((r) => ({
      ...presentForCustomer(r),
      restaurantName: r.restaurant?.name ?? null,
      restaurantSlug: r.restaurant?.slug ?? null,
    })),
    pagination: result.pagination,
  };
}

async function ownReview(customerId, id) {
  const review = await Review.findOne({
    _id: id,
    customer: customerId,
    status: { $ne: REVIEW_STATUS.DELETED },
  });
  if (!review) throw ApiError.notFound("Review not found");
  return review;
}

export async function getMine(customerId, id) {
  return presentForCustomer(await ownReview(customerId, id));
}

const sameList = (a = [], b = []) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export async function update(customerId, id, { rating, comment, images }) {
  const review = await ownReview(customerId, id);
  if (review.status !== REVIEW_STATUS.PUBLISHED)
    throw new ApiError(409, "This review was moderated and cannot be edited", {
      code: "REVIEW_LOCKED",
    });
  if (new Date() > editableUntil(review))
    throw new ApiError(
      409,
      `Reviews can be edited for ${REVIEW_POLICY.editWindowDays} days after posting`,
      { code: "EDIT_WINDOW_CLOSED" },
    );
  if (images?.length && review.target === T.RIDER)
    throw ApiError.badRequest("Delivery ratings don't take photos");
  const next = {
    rating: rating ?? review.rating,
    comment: comment ?? review.comment,
    images: images ?? [...review.images],
  };
  if (
    next.rating === review.rating &&
    next.comment === review.comment &&
    sameList(next.images, review.images)
  )
    return presentForCustomer(review);

  const now = new Date();
  // Conditional on the version we read, so the saved history is exact and a concurrent
  // moderation or edit wins cleanly.
  const updated = await Review.findOneAndUpdate(
    {
      _id: review._id,
      customer: customerId,
      status: REVIEW_STATUS.PUBLISHED,
      rating: review.rating,
      comment: review.comment,
    },
    {
      $set: { ...next, editedAt: now },
      $push: {
        edits: {
          rating: review.rating,
          comment: review.comment,
          images: [...review.images],
          replacedAt: now,
        },
      },
    },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) throw reviewChanged();
  if (next.rating !== review.rating) await refreshFor(updated);
  return presentForCustomer(updated);
}

/** Soft delete: it leaves every listing and summary, but the moderation record survives. */
export async function remove(customerId, id) {
  const review = await Review.findOneAndUpdate(
    {
      _id: id,
      customer: customerId,
      status: { $ne: REVIEW_STATUS.DELETED },
    },
    { $set: { status: REVIEW_STATUS.DELETED, deletedAt: new Date() } },
    { returnDocument: "before" },
  );
  if (!review) throw ApiError.notFound("Review not found");
  // Hidden and removed reviews never counted, so only a published one changes the rating.
  if (review.status === REVIEW_STATUS.PUBLISHED) await refreshFor(review);
  await rewardEvents.reviewWithdrawn(review, "review deleted");
  return { deleted: true };
}

// Reports
async function assertCanReport(user, review) {
  if (user.role === ROLES.CUSTOMER) {
    if (review.customer.equals(user._id))
      throw ApiError.badRequest("You cannot report your own review");
    return;
  }
  if (user.role === ROLES.RESTAURANT) {
    const own = await Restaurant.exists({
      _id: review.restaurant,
      owner: user._id,
    });
    if (own && review.target !== T.RIDER) return;
  }
  if (
    user.role === ROLES.DELIVERY &&
    review.target === T.RIDER &&
    review.deliveryPartner?.equals(user._id)
  )
    return;
  throw ApiError.notFound("Review not found");
}

export async function syncOpenReports(reviewId) {
  const openReports = await ReviewReport.countDocuments({
    review: reviewId,
    status: REPORT_STATUS.OPEN,
  });
  await Review.updateOne({ _id: reviewId }, { $set: { openReports } });
  return openReports;
}

export async function report(user, reviewId, { reason, note }) {
  const review = await Review.findOne({
    _id: reviewId,
    status: REVIEW_STATUS.PUBLISHED,
  });
  if (!review) throw ApiError.notFound("Review not found");
  await assertCanReport(user, review);
  try {
    await ReviewReport.create({
      review: review._id,
      reporter: user._id,
      reporterRole: user.role,
      reason,
      note,
    });
  } catch (error) {
    if (error.code === 11000)
      throw new ApiError(409, "You have already reported this review", {
        code: "ALREADY_REPORTED",
      });
    throw error;
  }
  const open = await syncOpenReports(review._id);
  if (open === 1)
    await notifyAdmins({
      type: "review.reported",
      title: "A review was reported",
      body: `Order ${review.orderNumber}: ${reason.replace("_", " ")}`,
      link: "/admin/reviews",
    }, PERMISSIONS.REVIEWS_MODERATE);
  return { reported: true };
}

// Public
async function publicPage(filter, query, pagination) {
  const full = {
    ...filter,
    status: REVIEW_STATUS.PUBLISHED,
    ...(query.rating && { rating: query.rating }),
  };
  const result = await page(full, query, pagination);
  return {
    items: result.items.map(presentPublic),
    pagination: result.pagination,
  };
}

// The summaries come from the cached `rating`, which refreshRating keeps exact.
export async function publicRestaurantReviews(restaurant, query, pagination) {
  const list = await publicPage(
    { target: T.RESTAURANT, restaurant: restaurant._id },
    query,
    pagination,
  );
  return { summary: restaurant.rating, ...list };
}

export async function publicFoodReviews(foodItemId, query, pagination) {
  const food = await FoodItem.findOne({ _id: foodItemId, deletedAt: null }).select("rating");
  if (!food) throw ApiError.notFound("Dish not found");
  const list = await publicPage({ target: T.FOOD, foodItem: food._id }, query, pagination);
  return { summary: food.rating, ...list };
}

// Restaurant
async function ownRestaurant(ownerId) {
  const restaurant = await Restaurant.findOne({ owner: ownerId }).select(
    "_id name rating",
  );
  if (!restaurant) throw ApiError.notFound("Create your restaurant first");
  return restaurant;
}

// Grouping by order: one row per order, whatever was reviewed on it.
const GROUP_SORTS = {
  newest: { lastAt: -1, _id: -1 },
  oldest: { firstAt: 1, _id: 1 },
  highest: { average: -1, lastAt: -1, _id: -1 },
  lowest: { average: 1, lastAt: -1, _id: -1 },
  reported: { openReports: -1, lastAt: -1, _id: -1 },
};

/**
 * The page of orders whose reviews match `match`, in `sort` order. Callers then load every review
 * of those orders their role may see, so a row always shows the whole order.
 */
export async function orderPage(match, sort, pagination) {
  const [result] = await Review.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$order",
        firstAt: { $min: "$createdAt" },
        lastAt: { $max: "$createdAt" },
        average: { $avg: "$rating" },
        openReports: { $sum: "$openReports" },
      },
    },
    { $sort: GROUP_SORTS[sort] ?? GROUP_SORTS.newest },
    {
      $facet: {
        ids: [{ $skip: pagination.skip }, { $limit: pagination.limit }],
        total: [{ $count: "n" }],
      },
    },
  ]);
  return {
    orderIds: result.ids.map((g) => g._id),
    pagination: paginationMeta(pagination, result.total[0]?.n ?? 0),
  };
}

/** Restaurant first, then dishes by name, then the rider: the order rows and dialogs use it. */
const TARGET_ORDER = { [T.RESTAURANT]: 0, [T.FOOD]: 1, [T.RIDER]: 2 };
export const byTarget = (a, b) =>
  TARGET_ORDER[a.target] - TARGET_ORDER[b.target] ||
  String(a.foodName ?? "").localeCompare(String(b.foodName ?? ""));

/** Reviews (already loaded) grouped per order, in `orderIds` order, with the shared row fields. */
export function groupReviews(orderIds, reviews) {
  const groups = new Map(orderIds.map((id) => [String(id), []]));
  for (const r of reviews) groups.get(String(r.order))?.push(r);
  return [...groups.entries()]
    .filter(([, list]) => list.length)
    .map(([order, list]) => orderGroup(order, list));
}

export function orderGroup(order, reviews) {
  reviews.sort(byTarget);
  return {
    order: String(order),
    orderNumber: reviews[0].orderNumber,
    customerName: reviews[0].customerName,
    createdAt: reviews.reduce((d, r) => (r.createdAt > d ? r.createdAt : d), reviews[0].createdAt),
    reviews,
  };
}

/** What a restaurant may see: published reviews of it and its dishes, never the rider's. */
const restaurantFilter = (restaurantId, query = {}) => ({
  restaurant: restaurantId,
  status: REVIEW_STATUS.PUBLISHED,
  target: query.target ?? { $in: [T.RESTAURANT, T.FOOD] },
  ...(query.foodItemId && { foodItem: toId(query.foodItemId) }),
  ...(query.rating && { rating: query.rating }),
  ...(query.responded === true && { "response.text": { $exists: true } }),
  ...(query.responded === false && { "response.text": { $exists: false } }),
});

function restaurantOrderView({ customerName, reviews, ...group }, reported) {
  return {
    ...group,
    authorName: shortName(customerName),
    unanswered: reviews.filter((r) => !r.response?.text).length,
    reviews: reviews.map((r) => presentForRestaurant(r, reported)),
  };
}

/** One row per order: its restaurant and dish reviews together. */
export async function restaurantOrders(ownerId, query, pagination) {
  const restaurant = await ownRestaurant(ownerId);
  const { orderIds, pagination: meta } = await orderPage(
    restaurantFilter(restaurant._id, query),
    query.sort,
    pagination,
  );
  const reviews = await Review.find({
    ...restaurantFilter(restaurant._id),
    order: { $in: orderIds },
  });
  const reported = await reportedBy(ownerId, reviews);
  return {
    items: groupReviews(orderIds, reviews).map((g) => restaurantOrderView(g, reported)),
    pagination: meta,
  };
}

/** Every review of one order (restaurant and dishes), for the order dialog. */
export async function restaurantOrder(ownerId, orderId) {
  const restaurant = await ownRestaurant(ownerId);
  const reviews = await Review.find({ ...restaurantFilter(restaurant._id), order: orderId });
  if (!reviews.length) throw ApiError.notFound("No reviews for this order");
  return restaurantOrderView(orderGroup(orderId, reviews), await reportedBy(ownerId, reviews));
}

/** Restaurant rating plus every dish's, for the summary cards and the dish filter. */
export async function restaurantSummary(ownerId) {
  const restaurant = await ownRestaurant(ownerId);
  const [foods, unanswered] = await Promise.all([
    FoodItem.find({ restaurant: restaurant._id, deletedAt: null })
      .select("name rating")
      .sort({ "rating.count": -1, name: 1 }),
    Review.countDocuments(restaurantFilter(restaurant._id, { responded: false })),
  ]);
  return {
    rating: restaurant.rating,
    unanswered,
    foods: foods.map((f) => ({
      id: String(f._id),
      name: f.name,
      rating: f.rating,
    })),
  };
}

async function ownRestaurantReview(ownerId, reviewId) {
  const restaurant = await ownRestaurant(ownerId);
  const review = await Review.findOne({ ...restaurantFilter(restaurant._id), _id: reviewId });
  if (!review) throw ApiError.notFound("Review not found");
  return { restaurant, review };
}

/** A public reply. It lives beside the review and never changes the customer's words. */
export async function respond(ownerId, reviewId, text) {
  const { restaurant, review } = await ownRestaurantReview(ownerId, reviewId);
  const now = new Date();
  const first = !review.response?.text;
  const updated = await Review.findOneAndUpdate(
    { _id: review._id, status: REVIEW_STATUS.PUBLISHED },
    {
      $set: {
        "response.text": text,
        "response.updatedAt": now,
        ...(first && { "response.respondedAt": now }),
      },
    },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) throw ApiError.notFound("Review not found");
  if (first)
    await notify(updated.customer, {
      type: "review.response",
      title: `${restaurant.name} replied to your review`,
      body: text.slice(0, 140),
      link: `/orders/${updated.order}`,
    });
  return presentForRestaurant(updated, await reportedBy(ownerId, [updated]));
}

export async function deleteResponse(ownerId, reviewId) {
  const { review } = await ownRestaurantReview(ownerId, reviewId);
  const updated = await Review.findOneAndUpdate(
    { _id: review._id },
    { $unset: { response: 1 } },
    { returnDocument: "after" },
  );
  return presentForRestaurant(updated, await reportedBy(ownerId, [updated]));
}

// Rider
export async function riderList(userId, query, pagination) {
  const filter = {
    target: T.RIDER,
    deliveryPartner: userId,
    status: REVIEW_STATUS.PUBLISHED,
    ...(query.rating && { rating: query.rating }),
  };
  const [profile, result] = await Promise.all([
    DeliveryPartner.findOne({ user: userId }).select("rating"),
    page(filter, query, pagination),
  ]);
  const reported = await reportedBy(userId, result.items);
  return {
    summary: profile?.rating ?? emptyRating(),
    items: result.items.map((r) => presentForRider(r, reported)),
    pagination: result.pagination,
  };
}
