export const DISPATCH = Object.freeze({
  // A rider has this long to accept an offered delivery before it moves on.
  offerTimeoutSeconds: 90,
  // Only riders within this straight-line distance of the restaurant are offered an order.
  maxPickupDistanceKm: 10,
  // A rider's last known location older than this is too stale to dispatch on.
  locationFreshMinutes: 15,
  // Online orders not paid within this time are cancelled (the restaurant never saw them).
  paymentWindowMinutes: 15,
  // A restaurant that does not accept or reject within this time auto-rejects the order.
  restaurantResponseMinutes: 10,
  // An order not picked up by a rider within this time of being ready is cancelled (and refunded if paid).
  pickupWindowMinutes: 30,
  // How often the background sweep expires offers, retries dispatch and times out orders.
  sweepIntervalMs: 15_000,
});
