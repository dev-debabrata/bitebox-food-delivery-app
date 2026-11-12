import { DISPATCH } from "../config/dispatch.js";
import { DeliveryPartner } from "../models/delivery-partner.model.js";
import {
  ACTIVE_STATUSES,
  ORDER_STATUS,
  Order,
} from "../models/order.model.js";
import { RESTAURANT_STATUS, Restaurant } from "../models/restaurant.model.js";
import { ROLES, User } from "../models/user.model.js";
import { day, fillDays, since } from "./reports.service.js";

const S = ORDER_STATUS;
const MINUTE = 60_000;

/** When an order entered `status`, from its history (aggregation expression). */
const enteredAt = (status) => ({
  $let: {
    vars: {
      h: {
        $filter: {
          input: "$statusHistory",
          cond: { $eq: ["$$this.status", status] },
        },
      },
    },
    in: { $min: "$$h.at" },
  },
});
const minutesBetween = (from, to) => ({
  $divide: [{ $subtract: [to, from] }, MINUTE],
});
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/** How long an order may sit in a status before operations should look at it. */
const LATE_AFTER_MINUTES = {
  [S.PENDING]: DISPATCH.restaurantResponseMinutes,
  [S.CONFIRMED]: 30,
  [S.PREPARING]: 45,
  [S.READY_FOR_PICKUP]: 15,
  [S.ASSIGNED]: 20,
  [S.ARRIVED_AT_RESTAURANT]: 10, // the rider is waiting at the counter
  [S.PICKED_UP]: 30,
  [S.ON_THE_WAY]: 45,
};

export async function dashboard(days) {
  const window = { createdAt: { $gte: since(days) } };
  const [[counts], liveByStatus, restaurants, riders] = await Promise.all([
    Order.aggregate([
      { $match: { ...window, submittedAt: { $ne: null } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ["$status", S.DELIVERED] }, 1, 0] } },
          cancelled: {
            $sum: {
              $cond: [{ $in: ["$status", [S.CANCELLED, S.REJECTED]] }, 1, 0],
            },
          },
        },
      },
    ]),
    Order.aggregate([
      { $match: { status: { $in: ACTIVE_STATUSES }, submittedAt: { $ne: null } } },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]),
    Restaurant.find({ status: RESTAURANT_STATUS.APPROVED }).select(
      "isAcceptingOrders openingTime closingTime timezone",
    ),
    DeliveryPartner.aggregate([
      {
        $group: {
          _id: null,
          online: { $sum: { $cond: ["$isOnline", 1, 0] } },
          busy: { $sum: { $cond: [{ $ne: ["$activeOrder", null] }, 1, 0] } },
          total: { $sum: 1 },
        },
      },
    ]),
  ]);
  const live = Object.fromEntries(liveByStatus.map((r) => [r._id, r.n]));
  const pendingRestaurants = await Restaurant.countDocuments({
    status: RESTAURANT_STATUS.PENDING,
  });
  return {
    days,
    orders: {
      total: counts?.total ?? 0,
      completed: counts?.completed ?? 0,
      cancelled: counts?.cancelled ?? 0,
      // Live, whatever the period: waiting for the restaurant, and anything still moving.
      pending: live[S.PENDING] ?? 0,
      active: Object.values(live).reduce((a, b) => a + b, 0),
      byStatus: live,
    },
    restaurants: {
      total: restaurants.length,
      openNow: restaurants.filter((r) => r.isOpenNow).length,
      paused: restaurants.filter((r) => !r.isAcceptingOrders).length,
      awaitingApproval: pendingRestaurants,
    },
    riders: {
      total: riders[0]?.total ?? 0,
      online: riders[0]?.online ?? 0,
      busy: riders[0]?.busy ?? 0,
    },
  };
}

/** Every live order with how long it has been in its current status; late ones first. */
export async function monitoring(now = new Date()) {
  const orders = await Order.find({
    status: { $in: ACTIVE_STATUSES },
    submittedAt: { $ne: null },
  })
    .sort({ createdAt: 1 })
    .limit(300)
    .populate("deliveryPartner", "name phone")
    .select(
      "orderNumber status statusHistory createdAt restaurantSnapshot.name deliveryPartner pricing.totalPaise paymentMethod offer",
    );
  const items = orders.map((o) => {
    const statusSince = o.statusHistory.at(-1)?.at ?? o.createdAt;
    const minutesInStatus = Math.floor((now - statusSince) / MINUTE);
    const lateAfter = LATE_AFTER_MINUTES[o.status];
    return {
      id: String(o._id),
      orderNumber: o.orderNumber,
      status: o.status,
      restaurantName: o.restaurantSnapshot?.name,
      rider: o.deliveryPartner
        ? { id: String(o.deliveryPartner._id), name: o.deliveryPartner.name }
        : null,
      offeredTo: o.offer?.partner ? String(o.offer.partner) : null,
      totalPaise: o.pricing.totalPaise,
      paymentMethod: o.paymentMethod,
      placedAt: o.createdAt,
      statusSince,
      minutesInStatus,
      late: lateAfter != null && minutesInStatus >= lateAfter,
    };
  });
  items.sort((a, b) => b.late - a.late || b.minutesInStatus - a.minutesInStatus);
  return { items, lateAfterMinutes: LATE_AFTER_MINUTES, at: now };
}

/** Approved restaurants with whether they take orders right now and their live order count. */
export async function restaurantAvailability() {
  const [restaurants, load] = await Promise.all([
    Restaurant.find({ status: RESTAURANT_STATUS.APPROVED })
      .sort({ name: 1 })
      .select(
        "name slug address.city isAcceptingOrders openingTime closingTime timezone",
      ),
    Order.aggregate([
      { $match: { status: { $in: ACTIVE_STATUSES }, submittedAt: { $ne: null } } },
      { $group: { _id: "$restaurant", n: { $sum: 1 } } },
    ]),
  ]);
  const active = new Map(load.map((r) => [String(r._id), r.n]));
  return {
    items: restaurants.map((r) => ({
      id: String(r._id),
      name: r.name,
      slug: r.slug,
      city: r.address?.city,
      isAcceptingOrders: r.isAcceptingOrders,
      isOpenNow: r.isOpenNow,
      hours: `${r.openingTime}–${r.closingTime}`,
      activeOrders: active.get(String(r._id)) ?? 0,
    })),
  };
}

/**
 * Delivery performance over the window: per day, delivered orders and the average minutes
 * from placing to delivery; overall, the average time in each stage and the top riders.
 */
export async function deliveryPerformance(days) {
  const delivered = {
    status: S.DELIVERED,
    "settlement.at": { $gte: since(days) },
  };
  const withTimes = {
    $addFields: {
      totalMin: minutesBetween("$createdAt", "$settlement.at"),
      prepMin: minutesBetween(enteredAt(S.CONFIRMED), enteredAt(S.READY_FOR_PICKUP)),
      waitMin: minutesBetween(enteredAt(S.READY_FOR_PICKUP), enteredAt(S.PICKED_UP)),
      rideMin: minutesBetween(enteredAt(S.PICKED_UP), "$settlement.at"),
    },
  };
  const [[stats], daily, riders] = await Promise.all([
    Order.aggregate([
      { $match: delivered },
      withTimes,
      {
        $group: {
          _id: null,
          delivered: { $sum: 1 },
          avgTotal: { $avg: "$totalMin" },
          avgPrep: { $avg: "$prepMin" },
          avgWait: { $avg: "$waitMin" },
          avgRide: { $avg: "$rideMin" },
          within45: { $sum: { $cond: [{ $lte: ["$totalMin", 45] }, 1, 0] } },
        },
      },
    ]),
    Order.aggregate([
      { $match: delivered },
      withTimes,
      {
        $group: {
          _id: day("$settlement.at"),
          delivered: { $sum: 1 },
          avgMinutes: { $avg: "$totalMin" },
        },
      },
    ]),
    Order.aggregate([
      { $match: delivered },
      withTimes,
      {
        $group: {
          _id: "$deliveryPartner",
          deliveries: { $sum: 1 },
          avgRide: { $avg: "$rideMin" },
          distanceMeters: { $sum: "$distanceMeters" },
        },
      },
      { $sort: { deliveries: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "u",
          pipeline: [{ $project: { name: 1 } }],
        },
      },
    ]),
  ]);
  return {
    days,
    totals: {
      delivered: stats?.delivered ?? 0,
      avgDeliveryMinutes: round1(stats?.avgTotal),
      avgPrepMinutes: round1(stats?.avgPrep),
      avgPickupWaitMinutes: round1(stats?.avgWait),
      avgRideMinutes: round1(stats?.avgRide),
      // Share of deliveries that took 45 minutes or less from placing the order.
      within45Percent: stats?.delivered
        ? Math.round((stats.within45 / stats.delivered) * 100)
        : null,
    },
    daily: fillDays(
      days,
      daily.map((d) => ({ ...d, avgMinutes: round1(d.avgMinutes) ?? 0 })),
      { delivered: 0, avgMinutes: 0 },
    ),
    topRiders: riders.map((r) => ({
      id: String(r._id),
      name: r.u[0]?.name ?? "Unknown rider",
      deliveries: r.deliveries,
      avgRideMinutes: round1(r.avgRide),
      distanceMeters: r.distanceMeters,
    })),
  };
}

/**
 * The admin home page's figures: people, all-time orders by state, and, for roles with
 * finance:view, gross order value, platform revenue and settlements not yet paid out.
 */
export async function platformSummary(includeMoney) {
  const [people, restaurants, approved, [orders]] = await Promise.all([
    User.aggregate([
      { $match: { role: { $in: [ROLES.CUSTOMER, ROLES.RESTAURANT, ROLES.DELIVERY] } } },
      { $group: { _id: "$role", n: { $sum: 1 } } },
    ]),
    Restaurant.countDocuments(),
    Restaurant.countDocuments({ status: RESTAURANT_STATUS.APPROVED }),
    Order.aggregate([
      { $match: { submittedAt: { $ne: null } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $in: ["$status", ACTIVE_STATUSES] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ["$status", S.DELIVERED] }, 1, 0] } },
          cancelled: {
            $sum: { $cond: [{ $in: ["$status", [S.CANCELLED, S.REJECTED]] }, 1, 0] },
          },
        },
      },
    ]),
  ]);
  const count = Object.fromEntries(people.map((p) => [p._id, p.n]));
  const data = {
    customers: count[ROLES.CUSTOMER] ?? 0,
    restaurants,
    approvedRestaurants: approved,
    deliveryPartners: count[ROLES.DELIVERY] ?? 0,
    orders: {
      total: orders?.total ?? 0,
      active: orders?.active ?? 0,
      completed: orders?.completed ?? 0,
      cancelled: orders?.cancelled ?? 0,
    },
  };
  if (includeMoney) {
    // A cancelled payout releases its orders (payouts.* back to null), so null means "due".
    const due = (side) => ({
      $sum: {
        $cond: [
          { $ifNull: [`$payouts.${side}`, false] },
          0,
          { $ifNull: [`$settlement.${side}Paise`, 0] },
        ],
      },
    });
    const [m] = await Order.aggregate([
      { $match: { status: S.DELIVERED, "settlement.at": { $ne: null } } },
      {
        $group: {
          _id: null,
          gmv: { $sum: "$pricing.totalPaise" },
          platform: { $sum: { $ifNull: ["$settlement.platformPaise", 0] } },
          restaurantsDue: due("restaurant"),
          ridersDue: due("rider"),
        },
      },
    ]);
    const { gmv = 0, platform = 0, restaurantsDue = 0, ridersDue = 0 } = m ?? {};
    data.money = {
      gmvPaise: gmv,
      platformRevenuePaise: platform,
      pendingSettlementsPaise: restaurantsDue + ridersDue,
      pendingRestaurantPaise: restaurantsDue,
      pendingRiderPaise: ridersDue,
    };
  }
  return data;
}
