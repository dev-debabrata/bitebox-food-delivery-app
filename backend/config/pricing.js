/**
 * Order pricing rules. All amounts are integer paise (₹1 = 100).
 * Changing these values changes what every new order costs, so keep them
 * here in one place and covered by tests.
 */
export const PRICING = Object.freeze({
  // Delivery fee: a base fee covers the first few km, then a per-km charge (rounded up), capped.
  deliveryBaseFeePaise: 2500, // ₹25
  deliveryBaseKm: 2,
  deliveryPerKmPaise: 800, // ₹8 per extra km
  deliveryMaxFeePaise: 9900, // ₹99
  // Orders at or above this subtotal (after discount) get free delivery.
  freeDeliveryThresholdPaise: 49900, // ₹499
  // Restaurants only deliver within this straight-line radius.
  maxDeliveryDistanceKm: 15,
  platformFeePaise: 500, // ₹5 per order
  // GST on food, applied to the subtotal after discount, in basis points (500 = 5%).
  foodTaxBasisPoints: 500,
});
