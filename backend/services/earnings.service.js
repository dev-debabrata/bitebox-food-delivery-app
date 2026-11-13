import { EARNINGS } from "../config/earnings.js";
import { CommissionRule } from "../models/commission-rule.model.js";

/**
 * The commission rate in effect now for a restaurant: its own open rule, else the global one,
 * else the default (config/earnings.js).
 */
export async function commissionBpFor(restaurantId) {
  const rules = await CommissionRule.find({
    effectiveTo: null,
    restaurant: { $in: [restaurantId, null] },
  }).lean();
  const own = rules.find((r) => r.restaurant && String(r.restaurant) === String(restaurantId));
  const global = rules.find((r) => !r.restaurant);
  return (own ?? global)?.basisPoints ?? EARNINGS.restaurantCommissionBasisPoints;
}

/** How a delivered order's money splits (`bp`: the commission in basis points). */
export function settlementFor(order, bp = EARNINGS.restaurantCommissionBasisPoints) {
  const foodPaise =
    order.pricing.subtotalPaise - (order.pricing.discountPaise ?? 0);
  const restaurantPaise = Math.round((foodPaise * (10_000 - bp)) / 10_000);
  const riderPaise =
    EARNINGS.riderBasePaise +
    Math.ceil((order.distanceMeters ?? 0) / 1000) * EARNINGS.riderPerKmPaise;
  return {
    restaurantPaise,
    riderPaise,
    platformPaise: order.pricing.totalPaise - restaurantPaise - riderPaise,
    commissionBp: bp,
  };
}
