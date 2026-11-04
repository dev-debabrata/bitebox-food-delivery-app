import { Coupon, CouponRedemption } from "../models/coupon.model.js";
import { ApiError } from "../utils/api-error.js";
import { escapeRegex, paginationMeta } from "../utils/pagination.js";

const invalid = (message, code = "COUPON_INVALID") => new ApiError(422, message, { code });

/**
 * Throws a 422 with a customer-friendly reason if the coupon cannot be used
 * for this cart. Returns the coupon document otherwise.
 */
export async function assertEligible(code, { userId, restaurantId, subtotalPaise, now = new Date() }, session = null) {
  const coupon = await Coupon.findOne({ code: String(code).trim().toUpperCase() }).session(session);
  if (!coupon || !coupon.isActive) throw invalid("This coupon code is not valid");
  if (now < coupon.validFrom) throw invalid("This coupon is not active yet");
  if (now > coupon.validUntil) throw invalid("This coupon has expired");
  if (coupon.restaurant && String(coupon.restaurant) !== String(restaurantId)) {
    throw invalid("This coupon is not valid at this restaurant");
  }
  if (subtotalPaise < coupon.minOrderPaise) {
    throw invalid(`Add items worth ₹${((coupon.minOrderPaise - subtotalPaise) / 100).toFixed(0)} more to use this coupon`, "COUPON_MIN_ORDER");
  }
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
    throw invalid("This coupon has been fully redeemed", "COUPON_EXHAUSTED");
  }
  const used = await CouponRedemption.countDocuments({ coupon: coupon._id, user: userId }).session(session);
  if (used >= coupon.perUserLimit) throw invalid("You have already used this coupon", "COUPON_USED");
  return coupon;
}

/** Coupons a customer could try right now (shown on the checkout page). */
export async function listAvailable({ restaurantId } = {}) {
  const now = new Date();
  const coupons = await Coupon.find({
    isActive: true,
    validFrom: { $lte: now },
    validUntil: { $gte: now },
    $and: [
      { $or: [{ restaurant: null }, ...(restaurantId ? [{ restaurant: restaurantId }] : [])] },
      { $or: [{ usageLimit: null }, { $expr: { $lt: ["$usedCount", "$usageLimit"] } }] },
    ],
  })
    .sort({ validUntil: 1 })
    .limit(20);
  return coupons.map(({ code, description, discountType, discountValue, maxDiscountPaise, minOrderPaise, validUntil }) => ({
    code,
    description,
    discountType,
    discountValue,
    maxDiscountPaise,
    minOrderPaise,
    validUntil,
  }));
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

const FIELDS = ["code", "description", "discountType", "discountValue", "maxDiscountPaise", "minOrderPaise", "validFrom", "validUntil", "isActive", "usageLimit", "perUserLimit", "restaurant"];
const pick = (source) => Object.fromEntries(FIELDS.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]));

export async function adminList({ search, active }, pagination) {
  const filter = {};
  if (search) filter.code = new RegExp(escapeRegex(search), "i");
  if (active !== undefined) filter.isActive = active;
  const [items, total] = await Promise.all([
    Coupon.find(filter).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit).populate("restaurant", "name slug"),
    Coupon.countDocuments(filter),
  ]);
  return { items, pagination: paginationMeta(pagination, total) };
}

export async function create(input) {
  return Coupon.create(pick(input));
}

export async function update(id, input) {
  const coupon = await Coupon.findById(id);
  if (!coupon) throw ApiError.notFound("Coupon not found");
  Object.assign(coupon, pick(input));
  return coupon.save();
}

/** Coupons that have been used are deactivated rather than deleted, to keep order history intact. */
export async function remove(id) {
  if (await CouponRedemption.exists({ coupon: id })) {
    throw ApiError.conflict("This coupon has been used. Deactivate it instead.");
  }
  const deleted = await Coupon.findByIdAndDelete(id);
  if (!deleted) throw ApiError.notFound("Coupon not found");
}
