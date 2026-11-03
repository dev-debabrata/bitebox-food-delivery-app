/**
 * How the money of a delivered order is split (integer paise), recorded on
 * the order as `settlement` when it is delivered. Kept in one place, like
 * pricing, so changes are deliberate and covered by tests.
 */
export const EARNINGS = Object.freeze({
  // BiteBox keeps this share of the food value (subtotal after the coupon); the restaurant gets the rest.
  restaurantCommissionBasisPoints: 1500, // 15%
  // Rider pay per delivery: a base amount plus a per-km rate on the straight-line trip, rounded up per km.
  riderBasePaise: 2000, // ₹20
  riderPerKmPaise: 600, // ₹6 per km
});
