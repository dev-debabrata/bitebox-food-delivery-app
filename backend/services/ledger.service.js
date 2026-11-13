import crypto from "node:crypto";
import { LEDGER_ACCOUNTS, LedgerEntry } from "../models/ledger-entry.model.js";
import { paginationMeta } from "../utils/pagination.js";

/**
 * The double-entry finance ledger (same rules as backend-django/apps/finance/ledger.py). Each
 * event posts one group whose signed amounts sum to zero, exactly once:
 * - order delivered: customer_payments +total; restaurant/rider/tax payable and platform revenue
 *   take their negative shares;
 * - payout paid: the payee's payable +amount; payouts −amount;
 * - refund after delivery: customer_payments −amount; restaurant_payable +deducted; platform
 *   revenue +the rest.
 */
export async function post(key, lines, { order = null, payout = null, description = "" } = {}) {
  const amounts = lines.filter(([, amount]) => amount);
  if (amounts.reduce((n, [, a]) => n + a, 0) !== 0) throw new Error(`Unbalanced ledger group ${key}`);
  if (await LedgerEntry.exists({ key })) return false;
  const group = crypto.randomUUID();
  try {
    await LedgerEntry.insertMany(
      amounts.map(([account, amountPaise]) => ({
        group,
        key,
        account,
        amountPaise,
        order,
        payout,
        description: description.slice(0, 200),
      })),
      { ordered: true },
    );
  } catch (error) {
    if (error?.code === 11000) return false; // the same event at the same moment
    throw error;
  }
  return true;
}

export function postSettlement(order) {
  const s = order.settlement;
  const tax = order.pricing.taxPaise ?? 0;
  return post(
    `settle:${order._id}`,
    [
      ["customer_payments", order.pricing.totalPaise],
      ["restaurant_payable", -s.restaurantPaise],
      ["rider_payable", -s.riderPaise],
      ["tax_payable", -tax],
      ["platform_revenue", -(s.platformPaise - tax)],
    ],
    { order: order._id, description: `Order ${order.orderNumber} delivered` },
  );
}

export const postPayoutPaid = (payout) =>
  post(
    `payout:${payout._id}`,
    [
      [payout.type === "restaurant" ? "restaurant_payable" : "rider_payable", payout.amountPaise],
      ["payouts", -payout.amountPaise],
    ],
    { payout: payout._id, description: `Payout to ${payout.payeeName}` },
  );

export const postRefund = (order, refundId, amount, fromRestaurant) =>
  post(
    `refund:${refundId}`,
    [
      ["customer_payments", -amount],
      ["restaurant_payable", fromRestaurant],
      ["platform_revenue", amount - fromRestaurant],
    ],
    { order: order._id, description: `Refund on order ${order.orderNumber}` },
  );

/** Balances per account (all time and in the window), whether every group balances, entries. */
export async function summary(days, pagination) {
  const since = new Date(Date.now() - days * 86_400_000);
  const balance = (match) =>
    LedgerEntry.aggregate([
      { $match: match },
      { $group: { _id: "$account", paise: { $sum: "$amountPaise" } } },
    ]);
  const [all, window, unbalanced, items, total] = await Promise.all([
    balance({}),
    balance({ createdAt: { $gte: since } }),
    LedgerEntry.aggregate([
      { $group: { _id: "$group", s: { $sum: "$amountPaise" } } },
      { $match: { s: { $ne: 0 } } },
      { $count: "n" },
    ]),
    LedgerEntry.find()
      .sort({ createdAt: -1, _id: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .populate("order", "orderNumber")
      .lean(),
    LedgerEntry.countDocuments(),
  ]);
  const map = (rows) => new Map(rows.map((r) => [r._id, r.paise]));
  const [a, w] = [map(all), map(window)];
  const n = unbalanced[0]?.n ?? 0;
  return {
    days,
    accounts: LEDGER_ACCOUNTS.map((account) => ({
      account,
      balancePaise: a.get(account) ?? 0,
      periodPaise: w.get(account) ?? 0,
    })),
    balanced: n === 0,
    unbalancedGroups: n,
    items: items.map((e) => ({
      id: String(e._id),
      group: e.group,
      account: e.account,
      amountPaise: e.amountPaise,
      description: e.description ?? "",
      orderNumber: e.order?.orderNumber ?? null,
      createdAt: e.createdAt,
    })),
    pagination: paginationMeta(pagination, total),
  };
}
