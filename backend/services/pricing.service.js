import { PRICING } from "../config/pricing.js";
import { DISCOUNT_TYPES } from "../models/coupon.model.js";

/** Coupon discount for a subtotal, never more than the subtotal itself. */
export function couponDiscount(coupon, subtotalPaise) {
  if (!coupon) return 0;
  let discount =
    coupon.discountType === DISCOUNT_TYPES.PERCENT
      ? Math.floor((subtotalPaise * coupon.discountValue) / 100)
      : coupon.discountValue;
  if (coupon.maxDiscountPaise)
    discount = Math.min(discount, coupon.maxDiscountPaise);
  return Math.max(0, Math.min(discount, subtotalPaise));
}

export function deliveryFee(distanceMeters, discountedSubtotalPaise) {
  if (discountedSubtotalPaise >= PRICING.freeDeliveryThresholdPaise) return 0;
  const km = distanceMeters / 1000;
  const extraKm = Math.max(0, Math.ceil(km - PRICING.deliveryBaseKm));
  return Math.min(
    PRICING.deliveryBaseFeePaise + extraKm * PRICING.deliveryPerKmPaise,
    PRICING.deliveryMaxFeePaise,
  );
}

export function computePricing({
  subtotalPaise,
  coupon = null,
  distanceMeters = null,
}) {
  const discountPaise = couponDiscount(coupon, subtotalPaise);
  const discounted = subtotalPaise - discountPaise;
  const deliveryFeePaise =
    distanceMeters === null ? 0 : deliveryFee(distanceMeters, discounted);
  const taxPaise = Math.round(
    (discounted * PRICING.foodTaxBasisPoints) / 10_000,
  );
  const platformFeePaise = subtotalPaise > 0 ? PRICING.platformFeePaise : 0;
  return {
    subtotalPaise,
    discountPaise,
    deliveryFeePaise,
    platformFeePaise,
    taxPaise,
    totalPaise: discounted + deliveryFeePaise + platformFeePaise + taxPaise,
  };
}
