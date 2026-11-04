import { EARNINGS } from "../config/earnings.js";

export function settlementFor(order) {
  const foodPaise =
    order.pricing.subtotalPaise - (order.pricing.discountPaise ?? 0);
  const restaurantPaise = Math.round(
    (foodPaise * (10_000 - EARNINGS.restaurantCommissionBasisPoints)) / 10_000,
  );
  const riderPaise =
    EARNINGS.riderBasePaise +
    Math.ceil((order.distanceMeters ?? 0) / 1000) * EARNINGS.riderPerKmPaise;
  return {
    restaurantPaise,
    riderPaise,
    platformPaise: order.pricing.totalPaise - restaurantPaise - riderPaise,
  };
}
