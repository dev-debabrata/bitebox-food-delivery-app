import mongoose from "mongoose";
import { env } from "../config/env.js";
import { DeliveryPartner } from "../models/delivery-partner.model.js";
import { ORDER_STATUS, Order, PAYMENT_STATUS } from "../models/order.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { ROLES, User } from "../models/user.model.js";
import { ApiError } from "../utils/api-error.js";

const S = ORDER_STATUS;
const tz = () => env.reportTimezone;
export const day = (field) => ({
  $dateToString: { format: "%Y-%m-%d", date: field, timezone: tz() },
});

/** The reporting window: the last `days` days up to now. */
export const since = (days) => new Date(Date.now() - days * 86_400_000);

/** Every day in the window (oldest first), so charts have no gaps on quiet days. */
function dayKeys(days) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return Array.from({ length: days }, (_, i) =>
    fmt.format(new Date(Date.now() - (days - 1 - i) * 86_400_000)),
  );
}

export function fillDays(days, rows, empty) {
  const byDay = new Map(rows.map(({ _id, ...rest }) => [_id, rest]));
  return dayKeys(days).map((date) => ({ date, ...empty, ...byDay.get(date) }));
}

const sum = (value) => ({ $sum: value });
const isDelivered = { $eq: ["$status", S.DELIVERED] };
const when = (condition, value = 1) => sum({ $cond: [condition, value, 0] });
/** Sums the given fields over rows (the day buckets), so totals need no extra query. */
const totalOf = (rows, fields) =>
  Object.fromEntries(
    fields.map((f) => [f, rows.reduce((n, r) => n + r[f], 0)]),
  );

async function earnings(match, share, days) {
  const delivered = {
    ...match,
    status: S.DELIVERED,
    "settlement.at": { $gte: since(days) },
  };
  const [daily, recent] = await Promise.all([
    Order.aggregate([
      { $match: delivered },
      {
        $group: {
          _id: day("$settlement.at"),
          orders: sum(1),
          earningsPaise: sum(`$settlement.${share}`),
          distanceMeters: sum("$distanceMeters"),
        },
      },
    ]),
    Order.find(delivered)
      .sort({ "settlement.at": -1 })
      .limit(20)
      .select(
        "orderNumber restaurantSnapshot.name deliveryAddress.area deliveryAddress.city pricing.totalPaise distanceMeters settlement",
      ),
  ]);
  return {
    days,
    totals: totalOf(daily, ["orders", "earningsPaise", "distanceMeters"]),
    daily: fillDays(days, daily, {
      orders: 0,
      earningsPaise: 0,
      distanceMeters: 0,
    }),
    recent: recent.map((o) => ({
      id: String(o._id),
      orderNumber: o.orderNumber,
      restaurantName: o.restaurantSnapshot.name,
      area: o.deliveryAddress.area || o.deliveryAddress.city,
      totalPaise: o.pricing.totalPaise,
      distanceMeters: o.distanceMeters,
      earningsPaise: o.settlement[share],
      deliveredAt: o.settlement.at,
    })),
  };
}

export async function restaurantEarnings(ownerId, days) {
  const restaurant = await Restaurant.findOne({ owner: ownerId }).select("_id");
  if (!restaurant) throw ApiError.notFound("Create your restaurant first");
  return earnings({ restaurant: restaurant._id }, "restaurantPaise", days);
}

export const riderEarnings = (userId, days) =>
  earnings({ deliveryPartner: userId }, "riderPaise", days);

export async function adminReport(days) {
  const placed = { createdAt: { $gte: since(days) } };
  const onlyDelivered = { $match: { status: S.DELIVERED } };
  // One pass over the window's orders; each facet is one section of the report.
  const [[r], newCustomers] = await Promise.all([
    Order.aggregate([
      { $match: placed },
      {
        $facet: {
          daily: [
            {
              $group: {
                _id: day("$createdAt"),
                orders: sum(1),
                delivered: when(isDelivered),
                gmvPaise: when(isDelivered, "$pricing.totalPaise"),
              },
            },
          ],
          money: [
            {
              $group: {
                _id: null,
                cancelled: when({
                  $in: ["$status", [S.CANCELLED, S.REJECTED]],
                }),
                platformRevenuePaise: sum({
                  $ifNull: ["$settlement.platformPaise", 0],
                }),
                refundedPaise: when(
                  { $eq: ["$paymentStatus", PAYMENT_STATUS.REFUNDED] },
                  "$pricing.totalPaise",
                ),
              },
            },
            { $project: { _id: 0 } },
          ],
          paymentMix: [
            onlyDelivered,
            {
              $group: {
                _id: "$paymentMethod",
                orders: sum(1),
                paise: sum("$pricing.totalPaise"),
              },
            },
          ],
          statuses: [{ $group: { _id: "$status", n: sum(1) } }],
          top: [
            onlyDelivered,
            {
              $group: {
                _id: "$restaurant",
                name: { $first: "$restaurantSnapshot.name" },
                orders: sum(1),
                gmvPaise: sum("$pricing.totalPaise"),
              },
            },
            { $sort: { gmvPaise: -1 } },
            { $limit: 5 },
          ],
        },
      },
    ]),
    User.countDocuments({ role: ROLES.CUSTOMER, ...placed }),
  ]);
  const t = totalOf(r.daily, ["orders", "delivered", "gmvPaise"]);
  return {
    days,
    totals: {
      ...t,
      ...(r.money[0] ?? {
        cancelled: 0,
        platformRevenuePaise: 0,
        refundedPaise: 0,
      }),
      averageOrderPaise: t.delivered ? Math.round(t.gmvPaise / t.delivered) : 0,
      newCustomers,
    },
    daily: fillDays(days, r.daily, { orders: 0, delivered: 0, gmvPaise: 0 }),
    paymentMix: r.paymentMix.map((p) => ({
      method: p._id,
      orders: p.orders,
      paise: p.paise,
    })),
    statusCounts: Object.fromEntries(r.statuses.map((x) => [x._id, x.n])),
    topRestaurants: r.top.map((x) => ({
      id: String(x._id),
      name: x.name,
      orders: x.orders,
      gmvPaise: x.gmvPaise,
    })),
  };
}

/** True when `field` falls in the current `unit` ("day" or "week", from Monday) in the report timezone. */
export const inCurrent = (field, unit) => ({
  $gte: [
    field,
    { $dateTrunc: { date: "$$NOW", unit, timezone: tz(), startOfWeek: "monday" } },
  ],
});

/**
 * The rider dashboard's figures: today and this week (Monday onwards), in env.reportTimezone,
 * from the settlements of delivered orders; all-time totals; the rating.
 */
export async function riderStats(userId) {
  const at = "$settlement.at";
  const pay = { $ifNull: ["$settlement.riderPaise", 0] };
  const [[row], profile] = await Promise.all([
    Order.aggregate([
      {
        $match: {
          deliveryPartner: new mongoose.Types.ObjectId(String(userId)),
          status: S.DELIVERED,
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          totalPaise: { $sum: pay },
          today: { $sum: { $cond: [inCurrent(at, "day"), 1, 0] } },
          todayPaise: { $sum: { $cond: [inCurrent(at, "day"), pay, 0] } },
          week: { $sum: { $cond: [inCurrent(at, "week"), 1, 0] } },
          weekPaise: { $sum: { $cond: [inCurrent(at, "week"), pay, 0] } },
        },
      },
    ]),
    DeliveryPartner.findOne({ user: userId }).select("rating"),
  ]);
  const window = (key) => ({
    deliveries: row?.[key] ?? 0,
    earningsPaise: row?.[`${key}Paise`] ?? 0,
  });
  return {
    today: window("today"),
    week: window("week"),
    total: window("total"),
    rating: { average: profile?.rating?.average ?? 0, count: profile?.rating?.count ?? 0 },
  };
}
