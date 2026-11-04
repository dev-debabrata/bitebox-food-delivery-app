import { REVIEW_POLICY } from "../config/reviews.js";
import { DeliveryPartner } from "../models/delivery-partner.model.js";
import {
  RESTAURANT_STATUS,
  Restaurant,
} from "../models/restaurant.model.js";
import {
  MODERATION_ACTIONS,
  REPORT_STATUS,
  REVIEW_STATUS,
  REVIEW_TARGETS,
  Review,
  ReviewReport,
} from "../models/review.model.js";
import { User } from "../models/user.model.js";
import { ApiError } from "../utils/api-error.js";
import { escapeRegex } from "../utils/pagination.js";
import { notify } from "./notification.service.js";
import { day, fillDays, since } from "./reports.service.js";
import {
  groupReviews,
  orderGroup,
  orderPage,
  refreshFor,
  reviewChanged,
  summarize,
  toId,
} from "./review.service.js";

const S = REVIEW_STATUS;
const A = MODERATION_ACTIONS;

/**
 * Admins change a review's visibility, never its words. Every change is a conditional update
 * ("still in status X") and is appended to the review's moderation log with who, when and why.
 */
export const MODERATION_MOVES = Object.freeze({
  [A.HIDE]: { from: [S.PUBLISHED], to: S.HIDDEN },
  [A.REMOVE]: { from: [S.PUBLISHED, S.HIDDEN], to: S.REMOVED },
  [A.RESTORE]: { from: [S.HIDDEN, S.REMOVED], to: S.PUBLISHED },
});

/** "hidden", "removed", "restored": for messages ("Review hidden", "cannot be removed"). */
export const PAST = Object.freeze({
  [A.HIDE]: "hidden",
  [A.REMOVE]: "removed",
  [A.RESTORE]: "restored",
});

const POPULATE = [
  { path: "restaurant", select: "name slug" },
  { path: "deliveryPartner", select: "name" },
];
const DETAIL_POPULATE = [
  ...POPULATE,
  { path: "customer", select: "name email" },
  { path: "moderationLog.by", select: "name" },
];

const ref = (v, extra = {}) =>
  v?._id ? { id: String(v._id), name: v.name, ...extra } : null;

function presentForAdmin(review) {
  return {
    ...review.toJSON(),
    customer: String(review.customer?._id ?? review.customer),
    order: String(review.order),
    restaurant: ref(review.restaurant, { slug: review.restaurant?.slug }),
    deliveryPartner: ref(review.deliveryPartner),
    foodItem: review.foodItem ? String(review.foodItem) : null,
  };
}

function adminFilter({ target, status, reported, rating, search, restaurantId }) {
  const filter = {
    status: status ?? { $ne: S.DELETED },
    ...(target && { target }),
    ...(rating && { rating }),
    ...(restaurantId && { restaurant: toId(restaurantId) }),
    ...(reported === true && { openReports: { $gt: 0 } }),
  };
  if (search) {
    const re = new RegExp(escapeRegex(search.trim()), "i");
    filter.$or = [
      { orderNumber: re },
      { customerName: re },
      { foodName: re },
      { comment: re },
    ];
  }
  return filter;
}

/** Order row fields every admin view shares. */
const adminOrderView = ({ reviews, ...group }, present) => ({
  ...group,
  restaurant: ref(reviews[0].restaurant),
  openReports: reviews.reduce((n, r) => n + (r.openReports ?? 0), 0),
  reviews: present(reviews),
});

/** One row per order: every review of it (deleted ones only when asked for). */
export async function adminOrders(query, pagination) {
  const [{ orderIds, pagination: meta }, [reported]] = await Promise.all([
    orderPage(adminFilter(query), query.reported === true ? "reported" : "newest", pagination),
    // Orders with an open report on a visible review: the "Reported" tab badge.
    Review.aggregate([
      { $match: { openReports: { $gt: 0 }, status: { $in: [S.PUBLISHED, S.HIDDEN] } } },
      { $group: { _id: "$order" } },
      { $count: "n" },
    ]),
  ]);
  const reviews = await Review.find({
    order: { $in: orderIds },
    ...(query.status !== S.DELETED && { status: { $ne: S.DELETED } }),
  }).populate(POPULATE);
  return {
    items: groupReviews(orderIds, reviews).map((g) =>
      adminOrderView(g, (list) => list.map(presentForAdmin)),
    ),
    pagination: meta,
    counts: { reported: reported?.n ?? 0 },
  };
}

/** Full records (earlier versions, reports, moderation log) for already loaded reviews. */
async function detailed(reviews) {
  const reports = await ReviewReport.find({ review: { $in: reviews.map((r) => r._id) } })
    .sort({ createdAt: -1 })
    .populate([
      { path: "reporter", select: "name" },
      { path: "resolvedBy", select: "name" },
    ]);
  return reviews.map((review) => ({
    ...presentForAdmin(review),
    customer: ref(review.customer, { email: review.customer?.email }),
    edits: review.edits ?? [],
    moderationLog: (review.moderationLog ?? []).map((m) => ({
      action: m.action,
      reason: m.reason,
      fromStatus: m.fromStatus,
      toStatus: m.toStatus,
      at: m.at,
      by: ref(m.by),
    })),
    reports: reports
      .filter((r) => r.review.equals(review._id))
      .map((r) => ({
        id: String(r._id),
        reason: r.reason,
        note: r.note ?? null,
        status: r.status,
        reporterRole: r.reporterRole,
        reporterName: r.reporter?.name ?? null,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt ?? null,
        resolvedBy: r.resolvedBy?.name ?? null,
      })),
  }));
}

const loadDetailed = (filter) =>
  Review.find(filter).select("+edits +moderationLog").populate(DETAIL_POPULATE);

/** Everything about one order's reviews: each with earlier versions, reports and its log. */
export async function adminOrder(orderId) {
  const reviews = await loadDetailed({ order: orderId });
  if (!reviews.length) throw ApiError.notFound("No reviews for this order");
  const view = adminOrderView(orderGroup(orderId, reviews), (list) => list);
  return {
    ...view,
    customerName: reviews[0].customer?.name ?? view.customerName,
    reviews: await detailed(view.reviews),
  };
}

/** The full record of one review. */
export async function adminGet(id) {
  const [review] = await loadDetailed({ _id: id });
  if (!review) throw ApiError.notFound("Review not found");
  return (await detailed([review]))[0];
}

const logEntry = (adminId, action, reason, fromStatus, toStatus) => ({
  action,
  reason,
  fromStatus,
  toStatus,
  by: adminId,
  at: new Date(),
});

/** Closes every open report of a review; the caller sets `openReports: 0` on the review. */
const closeReports = (reviewId, adminId, status) =>
  ReviewReport.updateMany(
    { review: reviewId, status: REPORT_STATUS.OPEN },
    { $set: { status, resolvedAt: new Date(), resolvedBy: adminId } },
  );

const MODERATION_MESSAGE = {
  [A.HIDE]: "Your review is hidden while we look into it",
  [A.REMOVE]: "Your review was removed",
  [A.RESTORE]: "Your review is visible again",
};

export async function moderate(adminId, id, { action, reason }) {
  const move = MODERATION_MOVES[action];
  const review = await Review.findById(id);
  if (!review) throw ApiError.notFound("Review not found");
  if (review.status === move.to) return adminGet(id); // repeating the same move is a no-op
  if (!move.from.includes(review.status))
    throw new ApiError(409, `A ${review.status} review cannot be ${PAST[action]}`, {
      code: "INVALID_MODERATION",
    });

  const hiding = move.to !== S.PUBLISHED;
  const updated = await Review.findOneAndUpdate(
    { _id: review._id, status: review.status },
    {
      $set: {
        status: move.to,
        moderation: { action, reason, at: new Date() },
        ...(hiding && { openReports: 0 }),
      },
      $push: {
        moderationLog: logEntry(adminId, action, reason, review.status, move.to),
      },
    },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) throw reviewChanged();

  await Promise.all([
    hiding && closeReports(updated._id, adminId, REPORT_STATUS.ACTIONED),
    // hidden -> removed changes no rating: neither counted.
    (review.status === S.PUBLISHED || move.to === S.PUBLISHED) && refreshFor(updated),
    notify(updated.customer, {
      type: "review.moderated",
      title: MODERATION_MESSAGE[action],
      body:
        action === A.RESTORE
          ? `Order ${updated.orderNumber}`
          : `Reason: ${reason}`.slice(0, 300),
      link: `/orders/${updated.order}`,
    }),
  ]);
  return adminGet(id);
}

/** "Nothing wrong here": closes the open reports and logs the decision; the review stays as it is. */
export async function dismissReports(adminId, id, reason) {
  const review = await Review.findOne({ _id: id, status: { $ne: S.DELETED } });
  if (!review) throw ApiError.notFound("Review not found");
  const { modifiedCount } = await closeReports(review._id, adminId, REPORT_STATUS.DISMISSED);
  if (!modifiedCount)
    throw new ApiError(409, "This review has no open reports", {
      code: "NO_OPEN_REPORTS",
    });
  await Review.updateOne(
    { _id: review._id },
    {
      $set: { openReports: 0 },
      $push: {
        moderationLog: logEntry(
          adminId,
          A.DISMISS_REPORTS,
          reason,
          review.status,
          review.status,
        ),
      },
    },
  );
  return adminGet(id);
}

// Analytics
const rankRows = (rows) =>
  rows.map((r) => ({
    id: String(r._id),
    name: r.name,
    average: r.rating.average,
    count: r.rating.count,
  }));

async function rankedRestaurants(direction) {
  const rows = await Restaurant.find({
    status: RESTAURANT_STATUS.APPROVED,
    "rating.count": { $gte: REVIEW_POLICY.minReviewsToRank },
  })
    .sort({ "rating.average": direction, "rating.count": -1 })
    .limit(5)
    .select("name rating")
    .lean();
  return rankRows(rows);
}

async function rankedRiders(direction) {
  const profiles = await DeliveryPartner.find({
    "rating.count": { $gte: REVIEW_POLICY.minReviewsToRank },
  })
    .sort({ "rating.average": direction, "rating.count": -1 })
    .limit(5)
    .select("user rating")
    .lean();
  const users = await User.find({
    _id: { $in: profiles.map((p) => p.user) },
  }).select("name");
  const names = new Map(users.map((u) => [String(u._id), u.name]));
  return rankRows(
    profiles.map((p) => ({ ...p, _id: p.user, name: names.get(String(p.user)) })),
  );
}

export async function analytics(days) {
  const from = since(days);
  const [[r], openReports, reportReasons, moderation, restaurants, riders] =
    await Promise.all([
      Review.aggregate([
        {
          $facet: {
            // All-time published reviews: what the public averages are built from.
            byTarget: [
              { $match: { status: S.PUBLISHED } },
              {
                $group: {
                  _id: { target: "$target", rating: "$rating" },
                  n: { $sum: 1 },
                },
              },
            ],
            statuses: [{ $group: { _id: "$status", n: { $sum: 1 } } }],
            daily: [
              {
                $match: { createdAt: { $gte: from }, status: { $ne: S.DELETED } },
              },
              {
                $group: {
                  _id: day("$createdAt"),
                  reviews: { $sum: 1 },
                  ratingSum: { $sum: "$rating" },
                },
              },
            ],
          },
        },
      ]),
      ReviewReport.countDocuments({ status: REPORT_STATUS.OPEN }),
      ReviewReport.aggregate([
        { $match: { createdAt: { $gte: from } } },
        { $group: { _id: "$reason", n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ]),
      Review.aggregate([
        { $match: { "moderationLog.at": { $gte: from } } },
        { $unwind: "$moderationLog" },
        { $match: { "moderationLog.at": { $gte: from } } },
        { $group: { _id: "$moderationLog.action", n: { $sum: 1 } } },
      ]),
      Promise.all([rankedRestaurants(-1), rankedRestaurants(1)]),
      Promise.all([rankedRiders(-1), rankedRiders(1)]),
    ]);

  const targets = Object.fromEntries(
    Object.values(REVIEW_TARGETS).map((t) => [
      t,
      summarize(
        r.byTarget
          .filter((x) => x._id.target === t)
          .map((x) => ({ rating: x._id.rating, n: x.n })),
      ),
    ]),
  );
  const daily = fillDays(days, r.daily, { reviews: 0, ratingSum: 0 }).map(
    ({ date, reviews, ratingSum }) => ({
      date,
      reviews,
      averageRating: reviews ? Math.round((ratingSum / reviews) * 100) / 100 : 0,
    }),
  );
  return {
    days,
    targets,
    statusCounts: Object.fromEntries(r.statuses.map((x) => [x._id, x.n])),
    newReviews: daily.reduce((n, d) => n + d.reviews, 0),
    openReports,
    reportReasons: reportReasons.map((x) => ({ reason: x._id, count: x.n })),
    moderationActions: Object.fromEntries(moderation.map((x) => [x._id, x.n])),
    daily,
    restaurants: { top: restaurants[0], bottom: restaurants[1] },
    riders: { top: riders[0], bottom: riders[1] },
    minReviewsToRank: REVIEW_POLICY.minReviewsToRank,
  };
}
