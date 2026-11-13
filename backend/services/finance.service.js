import { EARNINGS } from "../config/earnings.js";
import {
  ORDER_STATUS,
  Order,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  Payment,
} from "../models/order.model.js";
import { PAYOUT_STATUS, PAYOUT_TYPES, Payout } from "../models/payout.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { User } from "../models/user.model.js";
import { ApiError } from "../utils/api-error.js";
import { paginationMeta } from "../utils/pagination.js";
import { paymentView } from "./payments/payment.service.js";
import { CommissionRule } from "../models/commission-rule.model.js";
import { postPayoutPaid, postRefund } from "./ledger.service.js";
import { notify } from "./notification.service.js";
import { rupees } from "./order-notifications.js";
import { day, fillDays, since } from "./reports.service.js";

const S = ORDER_STATUS;
const P = PAYMENT_STATUS;

/** Each payout type: which order field links it, who the payee is, and their settlement share. */
const SIDE = {
  [PAYOUT_TYPES.RESTAURANT]: {
    link: "payouts.restaurant",
    payee: "$restaurant",
    // The restaurant's share net of refunds taken from it after delivery.
    share: {
      $subtract: [
        "$settlement.restaurantPaise",
        { $ifNull: ["$settlement.refundAdjustmentPaise", 0] },
      ],
    },
  },
  [PAYOUT_TYPES.RIDER]: {
    link: "payouts.rider",
    payee: "$deliveryPartner",
    share: "$settlement.riderPaise",
  },
};
/** Delivered, settled orders not yet in any payout of this type. */
const dueFilter = (type) => ({
  status: S.DELIVERED,
  "settlement.at": { $ne: null },
  [SIDE[type].link]: null,
});

async function dueTotals() {
  const [restaurant, rider] = await Promise.all(
    [PAYOUT_TYPES.RESTAURANT, PAYOUT_TYPES.RIDER].map((type) =>
      Order.aggregate([
        { $match: dueFilter(type) },
        { $group: { _id: null, paise: { $sum: SIDE[type].share } } },
      ]),
    ),
  );
  return {
    restaurantPaise: restaurant[0]?.paise ?? 0,
    riderPaise: rider[0]?.paise ?? 0,
  };
}

export async function dashboard(days) {
  const window = { createdAt: { $gte: since(days) } };
  const [[pay], daily, [settled], due, pendingPayouts] = await Promise.all([
    Payment.aggregate([
      { $match: window },
      {
        $group: {
          _id: null,
          transactions: { $sum: 1 },
          successful: { $sum: { $cond: [{ $in: ["$status", [P.PAID, P.REFUNDED]] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", P.FAILED] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $eq: ["$status", P.PENDING] }, 1, 0] } },
          collectedPaise: {
            $sum: { $cond: [{ $in: ["$status", [P.PAID, P.REFUNDED]] }, "$amountPaise", 0] },
          },
          refunds: { $sum: { $cond: [{ $eq: ["$status", P.REFUNDED] }, 1, 0] } },
          refundedPaise: {
            $sum: { $cond: [{ $eq: ["$status", P.REFUNDED] }, "$amountPaise", 0] },
          },
        },
      },
    ]),
    Payment.aggregate([
      { $match: { ...window, status: P.PAID } },
      { $group: { _id: day("$paidAt"), revenuePaise: { $sum: "$amountPaise" } } },
    ]),
    Order.aggregate([
      { $match: { status: S.DELIVERED, "settlement.at": { $gte: since(days) } } },
      {
        $group: {
          _id: null,
          platformPaise: { $sum: "$settlement.platformPaise" },
          restaurantPaise: { $sum: "$settlement.restaurantPaise" },
          riderPaise: { $sum: "$settlement.riderPaise" },
        },
      },
    ]),
    dueTotals(),
    Payout.aggregate([
      { $match: { status: PAYOUT_STATUS.PENDING } },
      { $group: { _id: null, n: { $sum: 1 }, paise: { $sum: "$amountPaise" } } },
    ]),
  ]);
  const collected = pay?.collectedPaise ?? 0;
  const refunded = pay?.refundedPaise ?? 0;
  return {
    days,
    totals: {
      // Money customers paid (cash collected on delivery counts once it is delivered).
      revenuePaise: collected - refunded,
      transactions: pay?.transactions ?? 0,
      successfulPayments: pay?.successful ?? 0,
      failedPayments: pay?.failed ?? 0,
      pendingPayments: pay?.pending ?? 0,
      refunds: pay?.refunds ?? 0,
      refundedPaise: refunded,
      platformCommissionPaise: settled?.platformPaise ?? 0,
      restaurantEarningsPaise: settled?.restaurantPaise ?? 0,
      riderEarningsPaise: settled?.riderPaise ?? 0,
      // Owed to partners: earned but not yet in a payout, plus payouts created but not yet paid.
      pendingPayoutPaise: due.restaurantPaise + due.riderPaise + (pendingPayouts[0]?.paise ?? 0),
      pendingPayoutBatches: pendingPayouts[0]?.n ?? 0,
    },
    daily: fillDays(days, daily, { revenuePaise: 0 }),
  };
}

/** One payment with its order, customer and settlement, for the transaction details view. */
export async function transaction(paymentId) {
  const payment = await Payment.findById(paymentId)
    .populate("user", "name email phone")
    .populate(
      "order",
      "orderNumber status pricing paymentMethod paymentStatus settlement restaurantSnapshot.name createdAt cancellation payouts",
    );
  if (!payment) throw ApiError.notFound("Transaction not found");
  const o = payment.order;
  return {
    id: String(payment._id),
    ...paymentView(payment),
    providerOrderId: payment.providerOrderId ?? null,
    providerPaymentId: payment.providerPaymentId ?? null,
    providerRefundId: payment.providerRefundId ?? null,
    createdAt: payment.createdAt,
    customer: payment.user
      ? {
          id: String(payment.user._id),
          name: payment.user.name,
          email: payment.user.email,
          phone: payment.user.phone ?? null,
        }
      : null,
    order: o
      ? {
          id: String(o._id),
          orderNumber: o.orderNumber,
          status: o.status,
          restaurantName: o.restaurantSnapshot?.name,
          pricing: o.pricing,
          settlement: o.settlement?.at ? o.settlement : null,
          cancellation: o.cancellation ?? null,
          paidOut: {
            restaurant: Boolean(o.payouts?.restaurant),
            rider: Boolean(o.payouts?.rider),
          },
          createdAt: o.createdAt,
        }
      : null,
  };
}

/** What each restaurant or rider is owed: delivered orders not yet in a payout. */
export async function payoutsDue(type) {
  const side = SIDE[type];
  const rows = await Order.aggregate([
    { $match: dueFilter(type) },
    {
      $group: {
        _id: side.payee,
        orders: { $sum: 1 },
        amountPaise: { $sum: side.share },
        from: { $min: "$settlement.at" },
        to: { $max: "$settlement.at" },
        restaurantName: { $first: "$restaurantSnapshot.name" },
      },
    },
    { $sort: { amountPaise: -1 } },
  ]);
  const names =
    type === PAYOUT_TYPES.RIDER
      ? new Map(
          (await User.find({ _id: { $in: rows.map((r) => r._id) } }).select("name")).map(
            (u) => [String(u._id), u.name],
          ),
        )
      : null;
  return {
    type,
    items: rows.map((r) => ({
      payeeId: String(r._id),
      name: names ? (names.get(String(r._id)) ?? "Unknown rider") : r.restaurantName,
      orders: r.orders,
      amountPaise: r.amountPaise,
      from: r.from,
      to: r.to,
    })),
  };
}

/**
 * Creates a payout for everything a payee is owed right now. Orders are claimed with one
 * conditional update, so an order can never land in two payouts even if two admins click at once.
 */
export async function createPayout(actor, type, payeeId, note) {
  const side = SIDE[type];
  let payee;
  let restaurant = null;
  if (type === PAYOUT_TYPES.RESTAURANT) {
    restaurant = await Restaurant.findById(payeeId).select("name owner");
    if (!restaurant) throw ApiError.notFound("Restaurant not found");
    payee = { id: restaurant.owner, name: restaurant.name };
  } else {
    const rider = await User.findById(payeeId).select("name role");
    if (!rider) throw ApiError.notFound("Rider not found");
    payee = { id: rider._id, name: rider.name };
  }
  const payout = await Payout.create({
    type,
    restaurant: restaurant?._id,
    payee: payee.id,
    payeeName: payee.name,
    note,
    createdBy: actor._id,
  });
  const match = {
    ...dueFilter(type),
    [type === PAYOUT_TYPES.RESTAURANT ? "restaurant" : "deliveryPartner"]: payeeId,
  };
  await Order.updateMany(match, { $set: { [side.link]: payout._id } });
  const [sum] = await Order.aggregate([
    { $match: { [side.link]: payout._id } },
    {
      $group: {
        _id: null,
        orders: { $sum: 1 },
        amountPaise: { $sum: side.share },
        from: { $min: "$settlement.at" },
        to: { $max: "$settlement.at" },
      },
    },
  ]);
  if (!sum) {
    await payout.deleteOne();
    throw ApiError.badRequest("Nothing is due for this payee");
  }
  Object.assign(payout, {
    orders: sum.orders,
    amountPaise: sum.amountPaise,
    periodFrom: sum.from,
    periodTo: sum.to,
  });
  return (await payout.save()).toJSON();
}

export async function markPayoutPaid(actor, id, reference) {
  const payout = await Payout.findOneAndUpdate(
    { _id: id, status: PAYOUT_STATUS.PENDING },
    { status: PAYOUT_STATUS.PAID, reference, paidBy: actor._id, paidAt: new Date() },
    { new: true },
  );
  if (!payout) throw ApiError.conflict("Only a pending payout can be marked as paid");
  await postPayoutPaid(payout);
  // The "settlement processed" event.
  await notify(payout.payee, {
    type: "payout.paid",
    title: `Payout of ${rupees(payout.amountPaise)} sent`,
    body: `For ${payout.orders} orders. Bank reference ${reference}.`,
    link: payout.type === PAYOUT_TYPES.RESTAURANT ? "/restaurant/earnings" : "/delivery/earnings",
  });
  return payout.toJSON();
}

/** Cancels a pending payout and releases its orders, so they show as due again. */
export async function cancelPayout(id, note) {
  const payout = await Payout.findOneAndUpdate(
    { _id: id, status: PAYOUT_STATUS.PENDING },
    { status: PAYOUT_STATUS.CANCELLED, ...(note && { note }) },
    { new: true },
  );
  if (!payout) throw ApiError.conflict("Only a pending payout can be cancelled");
  await Order.updateMany(
    { [SIDE[payout.type].link]: payout._id },
    { $set: { [SIDE[payout.type].link]: null } },
  );
  return payout.toJSON();
}

export async function listPayouts({ type, status }, pagination) {
  const filter = {};
  if (type) filter.type = type;
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    Payout.find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit),
    Payout.countDocuments(filter),
  ]);
  return {
    items: items.map((p) => p.toJSON()),
    pagination: paginationMeta(pagination, total),
  };
}

/**
 * Refund queue: online payments already refunded, plus paid ones whose order closed without
 * a refund (the automatic refund failed and needs a retry).
 */
export async function refunds({ state }, pagination) {
  const closed = await Order.find({
    status: { $in: [S.CANCELLED, S.REJECTED] },
    paymentMethod: PAYMENT_METHODS.ONLINE,
    paymentStatus: P.PAID,
  })
    .select("_id")
    .limit(500)
    .lean();
  const needed = { status: P.PAID, order: { $in: closed.map((o) => o._id) } };
  const done = { status: P.REFUNDED };
  const filter =
    state === "needed" ? needed : state === "refunded" ? done : { $or: [needed, done] };
  const [items, total] = await Promise.all([
    Payment.find(filter)
      .sort({ updatedAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .populate("order", "orderNumber status cancellation")
      .populate("user", "name email"),
    Payment.countDocuments(filter),
  ]);
  return {
    items: items.map((p) => ({
      id: String(p._id),
      ...paymentView(p),
      refundNeeded: p.status === P.PAID,
      customer: p.user ? { name: p.user.name, email: p.user.email } : null,
      order: p.order
        ? {
            id: String(p.order._id),
            orderNumber: p.order.orderNumber,
            status: p.order.status,
            reason: p.order.cancellation?.reason ?? null,
          }
        : null,
      updatedAt: p.updatedAt,
    })),
    pagination: paginationMeta(pagination, total),
  };
}

/** The commission rates and what they earned per restaurant over the window. */
export async function commission(days) {
  const rows = await Order.aggregate([
    { $match: { status: S.DELIVERED, "settlement.at": { $gte: since(days) } } },
    {
      $group: {
        _id: "$restaurant",
        name: { $first: "$restaurantSnapshot.name" },
        orders: { $sum: 1 },
        foodPaise: {
          $sum: { $subtract: ["$pricing.subtotalPaise", { $ifNull: ["$pricing.discountPaise", 0] }] },
        },
        restaurantPaise: { $sum: "$settlement.restaurantPaise" },
        platformPaise: { $sum: "$settlement.platformPaise" },
      },
    },
    { $sort: { platformPaise: -1 } },
  ]);
  const items = rows.map((r) => ({
    restaurantId: String(r._id),
    name: r.name,
    orders: r.orders,
    foodPaise: r.foodPaise,
    commissionPaise: r.foodPaise - r.restaurantPaise,
    restaurantPaise: r.restaurantPaise,
    platformPaise: r.platformPaise,
  }));
  const sum = (field) => items.reduce((n, r) => n + r[field], 0);
  return {
    days,
    rates: {
      restaurantCommissionPercent: (await globalRate()) / 100,
      riderBasePaise: EARNINGS.riderBasePaise,
      riderPerKmPaise: EARNINGS.riderPerKmPaise,
    },
    totals: {
      orders: sum("orders"),
      foodPaise: sum("foodPaise"),
      commissionPaise: sum("commissionPaise"),
      platformPaise: sum("platformPaise"),
    },
    items,
  };
}

// Commission rules ----------------------------------------------------------------------------

async function globalRate() {
  const rule = await CommissionRule.findOne({ restaurant: null, effectiveTo: null }).lean();
  return rule?.basisPoints ?? EARNINGS.restaurantCommissionBasisPoints;
}

function ruleJson(r) {
  return {
    id: String(r._id),
    restaurant: r.restaurant ? { id: String(r.restaurant._id), name: r.restaurant.name } : null,
    basisPoints: r.basisPoints,
    percent: r.basisPoints / 100,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo ?? null,
    note: r.note || null,
    createdBy: r.createdBy?.name ?? null,
  };
}

/** The global rate, every restaurant override in force, and the recent history. */
export async function commissionRules() {
  const populated = (q) => q.populate("restaurant", "name").populate("createdBy", "name").lean();
  const [rate, overrides, history] = await Promise.all([
    globalRate(),
    populated(CommissionRule.find({ restaurant: { $ne: null }, effectiveTo: null })),
    populated(CommissionRule.find().sort({ effectiveFrom: -1, _id: -1 }).limit(50)),
  ]);
  return {
    global: {
      basisPoints: rate,
      percent: rate / 100,
      defaultBasisPoints: EARNINGS.restaurantCommissionBasisPoints,
    },
    overrides: overrides
      .map(ruleJson)
      .sort((a, b) => a.restaurant.name.localeCompare(b.restaurant.name)),
    history: history.map(ruleJson),
  };
}

/** A new rate for a scope (restaurantId null = global): the open rule closes, a new one opens. */
export async function setCommission(actor, restaurantId, basisPoints, note) {
  if (restaurantId && !(await Restaurant.exists({ _id: restaurantId })))
    throw ApiError.notFound("Restaurant not found");
  const now = new Date();
  const scope = { restaurant: restaurantId || null, effectiveTo: null };
  await CommissionRule.updateOne(scope, { $set: { effectiveTo: now } });
  await CommissionRule.create({
    restaurant: restaurantId || null,
    basisPoints,
    effectiveFrom: now,
    note,
    createdBy: actor._id,
  });
  return commissionRules();
}

/** Removes a restaurant's own rate: the global one applies again. */
export async function clearCommission(restaurantId) {
  const { modifiedCount } = await CommissionRule.updateOne(
    { restaurant: restaurantId, effectiveTo: null },
    { $set: { effectiveTo: new Date() } },
  );
  if (!modifiedCount) throw ApiError.notFound("This restaurant has no commission of its own");
  return commissionRules();
}

// Refund deductions -----------------------------------------------------------------------------

/**
 * A refund finished on a delivered order: it comes off the restaurant's share while that is not
 * yet in a payout (never below zero); BiteBox carries the rest. Posted to the ledger once.
 */
export async function applyRefund(order, refundId, amount) {
  if (!order.settlement?.at) return;
  const { LedgerEntry } = await import("../models/ledger-entry.model.js");
  if (await LedgerEntry.exists({ key: `refund:${refundId}` })) return;
  let deducted = 0;
  if (!order.payouts?.restaurant) {
    const room = order.settlement.restaurantPaise - (order.settlement.refundAdjustmentPaise ?? 0);
    deducted = Math.max(0, Math.min(amount, room));
    if (deducted)
      await Order.updateOne(
        { _id: order._id, "payouts.restaurant": null },
        { $inc: { "settlement.refundAdjustmentPaise": deducted } },
      );
  }
  await postRefund(order, refundId, amount, deducted);
}

// Partner history and the settlement report --------------------------------------------------

/** A partner's own payouts (`match`: { restaurant } or { type: "rider", payee }). */
export const myPayouts = (match, pagination) => listPayoutsMatching(match, pagination);

async function listPayoutsMatching(filter, pagination) {
  const [items, total] = await Promise.all([
    Payout.find(filter).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit),
    Payout.countDocuments(filter),
  ]);
  return { items: items.map((p) => p.toJSON()), pagination: paginationMeta(pagination, total) };
}

/** Per delivered order: what it paid this partner and whether it has been paid out. */
export async function settlementHistory(type, match, pagination) {
  const filter = { ...match, status: S.DELIVERED, "settlement.at": { $ne: null } };
  const link = type === PAYOUT_TYPES.RESTAURANT ? "restaurant" : "rider";
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ "settlement.at": -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .select("orderNumber pricing settlement payouts")
      .populate(`payouts.${link}`, "status paidAt")
      .lean(),
    Order.countDocuments(filter),
  ]);
  return {
    items: orders.map((o) => {
      const s = o.settlement;
      const food = o.pricing.subtotalPaise - (o.pricing.discountPaise ?? 0);
      const adjustment = s.refundAdjustmentPaise ?? 0;
      const payout = o.payouts?.[link];
      return {
        orderId: String(o._id),
        orderNumber: o.orderNumber,
        settledAt: s.at,
        foodPaise: food,
        commissionBp: s.commissionBp ?? EARNINGS.restaurantCommissionBasisPoints,
        commissionPaise: food - s.restaurantPaise,
        refundAdjustmentPaise: adjustment,
        netPaise: type === PAYOUT_TYPES.RIDER ? s.riderPaise : s.restaurantPaise - adjustment,
        payout: payout ? { id: String(payout._id), status: payout.status, paidAt: payout.paidAt ?? null } : null,
      };
    }),
    pagination: paginationMeta(pagination, total),
  };
}

/** Text a spreadsheet would run as a formula (starts with = + - @, tab or CR): quote it. */
export const spreadsheetSafe = (text) => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);

/** The settlement report (one row per delivered order) for spreadsheets and accountants. */
export async function settlementsCsv({ from, to } = {}) {
  const at = { $ne: null, ...(from && { $gte: from }), ...(to && { $lte: to }) };
  const orders = await Order.find({ status: S.DELIVERED, "settlement.at": at })
    .sort({ "settlement.at": 1 })
    .select("orderNumber restaurantSnapshot.name pricing settlement payouts")
    .populate("payouts.restaurant payouts.rider", "status")
    .lean();
  const money = (p) => ((p ?? 0) / 100).toFixed(2);
  const cell = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [
    [
      "Order", "Delivered at", "Restaurant", "Order total (₹)", "Tax (₹)", "Commission %",
      "Restaurant share (₹)", "Refund deduction (₹)", "Rider pay (₹)", "BiteBox share (₹)",
      "Restaurant payout", "Rider payout",
    ],
    ...orders.map((o) => [
      o.orderNumber,
      new Date(o.settlement.at).toISOString(),
      spreadsheetSafe(o.restaurantSnapshot?.name ?? ""), // partner-written
      money(o.pricing.totalPaise),
      money(o.pricing.taxPaise),
      (o.settlement.commissionBp ?? EARNINGS.restaurantCommissionBasisPoints) / 100,
      money(o.settlement.restaurantPaise),
      money(o.settlement.refundAdjustmentPaise),
      money(o.settlement.riderPaise),
      money(o.settlement.platformPaise),
      o.payouts?.restaurant?.status ?? "due",
      o.payouts?.rider?.status ?? "due",
    ]),
  ];
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
