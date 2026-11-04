import { EARNINGS } from "../config/earnings.js";

/**
 * Who earns what from a delivered order (integer paise, see config/earnings.js):
 * - restaurant: the food value after the coupon, minus BiteBox's commission;
 * - rider: base pay + per-km pay on the straight-line trip (rounded up per km);
 * - platform: everything else the customer paid (fees, taxes to remit, commission).
 */
export function settlementFor(order) {
  const foodPaise = order.pricing.subtotalPaise - (order.pricing.discountPaise ?? 0);
  const restaurantPaise = Math.round((foodPaise * (10_000 - EARNINGS.restaurantCommissionBasisPoints)) / 10_000);
  const riderPaise = EARNINGS.riderBasePaise + Math.ceil((order.distanceMeters ?? 0) / 1000) * EARNINGS.riderPerKmPaise;
  return {
    restaurantPaise,
    riderPaise,
    platformPaise: order.pricing.totalPaise - restaurantPaise - riderPaise,
  };
}
