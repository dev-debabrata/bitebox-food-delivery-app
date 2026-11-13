import { Order } from "../models/order.model.js";
import { PAYOUT_TYPES, Payout } from "../models/payout.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { ROLES } from "../models/user.model.js";
import * as finance from "../services/finance.service.js";
import { orderInvoice, payoutStatement } from "../services/invoice.service.js";
import { ApiError } from "../utils/api-error.js";
import { download, respond } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";

/**
 * Settlement and payout history for restaurants (/my/restaurant/...) and riders (/delivery/...),
 * and the PDF downloads. Each partner only ever sees their own.
 */
async function scope(user) {
  if (user.role === ROLES.RESTAURANT) {
    const restaurant = await Restaurant.findOne({ owner: user._id }).select("_id");
    if (!restaurant) throw ApiError.notFound("Create your restaurant first");
    return {
      type: PAYOUT_TYPES.RESTAURANT,
      payouts: { restaurant: restaurant._id },
      orders: { restaurant: restaurant._id },
    };
  }
  return {
    type: PAYOUT_TYPES.RIDER,
    payouts: { type: PAYOUT_TYPES.RIDER, payee: user._id },
    orders: { deliveryPartner: user._id },
  };
}

const page = (req) => parsePagination(req.validatedQuery, { defaultLimit: 10 });
const pdf = ({ name, pdf: body }) => ({ name, body, type: "application/pdf" });

export const myPayouts = respond(async (req) =>
  finance.myPayouts((await scope(req.user)).payouts, page(req)),
);

export const mySettlements = respond(async (req) => {
  const s = await scope(req.user);
  return finance.settlementHistory(s.type, s.orders, page(req));
});

export const myStatement = download(async (req) => {
  const payout = await Payout.findOne({ _id: req.params.id, ...(await scope(req.user)).payouts });
  if (!payout) throw ApiError.notFound("Payout not found");
  return pdf(await payoutStatement(payout));
});

/** A customer's own delivered order (or any order, for admins with finance:view). */
export const orderInvoiceFor = (own) =>
  download(async (req) => {
    const order = await Order.findOne({ _id: req.params.id, ...(own && { customer: req.user._id }) });
    if (!order) throw ApiError.notFound("Order not found");
    return pdf(await orderInvoice(order));
  });
