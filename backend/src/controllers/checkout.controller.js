import * as addressService from "../services/address.service.js";
import * as cartService from "../services/cart.service.js";
import * as couponService from "../services/coupon.service.js";
import * as orderService from "../services/order.service.js";
import { sendSuccess } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";

const quoteFor = (req) => cartService.buildQuote(req.user._id, { addressId: req.validatedQuery?.addressId });

// ---------------------------------------------------------------------------
// Cart: every mutation responds with the freshly priced cart.
// ---------------------------------------------------------------------------
export async function getCart(req, res) {
  sendSuccess(res, { data: await quoteFor(req) });
}

export async function addItem(req, res) {
  await cartService.addItem(req.user._id, req.body);
  sendSuccess(res, { message: "Added to cart", data: await quoteFor(req) });
}

export async function setQuantity(req, res) {
  await cartService.setQuantity(req.user._id, req.params.foodItemId, req.body.quantity);
  sendSuccess(res, { message: "Cart updated", data: await quoteFor(req) });
}

export async function removeItem(req, res) {
  await cartService.removeItem(req.user._id, req.params.foodItemId);
  sendSuccess(res, { message: "Removed from cart", data: await quoteFor(req) });
}

export async function clearCart(req, res) {
  await cartService.clear(req.user._id);
  sendSuccess(res, { message: "Cart cleared", data: await quoteFor(req) });
}

export async function applyCoupon(req, res) {
  await cartService.applyCoupon(req.user._id, req.body.code);
  sendSuccess(res, { message: "Coupon applied", data: await quoteFor(req) });
}

export async function removeCoupon(req, res) {
  await cartService.removeCoupon(req.user._id);
  sendSuccess(res, { message: "Coupon removed", data: await quoteFor(req) });
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------
export async function listAddresses(req, res) {
  const addresses = await addressService.list(req.user._id);
  sendSuccess(res, { data: { addresses: addresses.map((a) => a.toJSON()) } });
}

export async function createAddress(req, res) {
  const address = await addressService.create(req.user._id, req.body);
  sendSuccess(res, { statusCode: 201, message: "Address saved", data: { address: address.toJSON() } });
}

export async function updateAddress(req, res) {
  const address = await addressService.update(req.user._id, req.params.id, req.body);
  sendSuccess(res, { message: "Address updated", data: { address: address.toJSON() } });
}

export async function setDefaultAddress(req, res) {
  const address = await addressService.setDefault(req.user._id, req.params.id);
  sendSuccess(res, { message: "Default address updated", data: { address: address.toJSON() } });
}

export async function deleteAddress(req, res) {
  await addressService.remove(req.user._id, req.params.id);
  sendSuccess(res, { message: "Address deleted" });
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
export async function placeOrder(req, res) {
  const { order, created } = await orderService.placeOrder(req.user._id, req.body, req.get("idempotency-key"));
  sendSuccess(res, {
    statusCode: created ? 201 : 200,
    message: created ? "Order placed" : "Order already placed",
    data: { order: order.toJSON() },
  });
}

export async function listMyOrders(req, res) {
  const data = await orderService.listMine(req.user._id, parsePagination(req.validatedQuery, { defaultLimit: 10 }));
  sendSuccess(res, { data: { ...data, items: data.items.map((o) => o.toJSON()) } });
}

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------
export async function availableCoupons(req, res) {
  sendSuccess(res, { data: { coupons: await couponService.listAvailable({ restaurantId: req.validatedQuery.restaurantId }) } });
}

export async function adminListCoupons(req, res) {
  const data = await couponService.adminList(req.validatedQuery, parsePagination(req.validatedQuery));
  sendSuccess(res, { data: { ...data, items: data.items.map((c) => c.toJSON()) } });
}

export async function adminCreateCoupon(req, res) {
  const coupon = await couponService.create(req.body);
  sendSuccess(res, { statusCode: 201, message: "Coupon created", data: { coupon: coupon.toJSON() } });
}

export async function adminUpdateCoupon(req, res) {
  const coupon = await couponService.update(req.params.id, req.body);
  sendSuccess(res, { message: "Coupon saved", data: { coupon: coupon.toJSON() } });
}

export async function adminDeleteCoupon(req, res) {
  await couponService.remove(req.params.id);
  sendSuccess(res, { message: "Coupon deleted" });
}
