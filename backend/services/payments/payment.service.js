import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import {
  ORDER_STATUS,
  Order,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  Payment,
} from "../../models/order.model.js";
import { REFUND_STATUS, Refund } from "../../models/refund.model.js";
import { User } from "../../models/user.model.js";
import { emitOrderUpdated } from "../../sockets/events.js";
import { ApiError } from "../../utils/api-error.js";
import { escapeRegex, paginationMeta } from "../../utils/pagination.js";
import { notifyNewOrder, notifyRefund, rupees } from "../order-notifications.js";
import { startSweepLoop } from "../../utils/sweep-loop.js";
import * as rewardEvents from "../reward-events.js";
import { mockProvider } from "./mock.provider.js";
import { razorpayFromEnv } from "./razorpay.provider.js";

const P = PAYMENT_STATUS;
const R = REFUND_STATUS;
const CLOSED = [ORDER_STATUS.CANCELLED, ORDER_STATUS.REJECTED];
const REFUNDABLE = [P.PAID, P.PARTIALLY_REFUNDED];
const REFUND_DONE = [R.PROCESSED, R.MANUAL_DONE];
const REFUND_OPEN = [R.PENDING, R.PROCESSING, R.MANUAL_PENDING];
const REFUND_FAILED_NOTE = "Refund failed; retry from the admin panel";
const MINUTE = 60_000;
const PROVIDER_FOR_COD = "cash_on_delivery";

/**
 * The online payment provider in use: Razorpay when its keys are set, otherwise
 * the simulated provider outside production, otherwise none (cash only).
 * Tests swap it with `useOnlineProvider`.
 */
let online =
  razorpayFromEnv() ?? (env.payments.mockEnabled ? mockProvider : null);

export function useOnlineProvider(provider) {
  const previous = online;
  online = provider;
  return () => {
    online = previous;
  };
}

export const onlineProvider = () => online;

/** Payment methods offered at checkout. */
export function availableMethods() {
  return [
    {
      method: PAYMENT_METHODS.COD,
      label: "Cash on delivery",
      provider: PROVIDER_FOR_COD,
      simulated: false,
    },
    ...(online
      ? [
          {
            method: PAYMENT_METHODS.ONLINE,
            label: online.label,
            provider: online.name,
            simulated: online.simulated,
          },
        ]
      : []),
  ];
}

/** Provider name stored on a new order's Payment record. */
export function providerFor(method) {
  if (method === PAYMENT_METHODS.COD) return PROVIDER_FOR_COD;
  if (!online)
    throw ApiError.badRequest("Online payment is not available right now");
  return online.name;
}

const conflict = (message, code) => new ApiError(409, message, { code });
const unavailable = (message) =>
  new ApiError(503, message, { code: "PAYMENT_UNAVAILABLE" });

async function loadForCustomer(userId, orderId) {
  const order = await Order.findOne({ _id: orderId, customer: userId });
  if (!order) throw ApiError.notFound("Order not found");
  const payment = await Payment.findOne({ order: order._id });
  if (!payment || payment.method !== PAYMENT_METHODS.ONLINE)
    throw ApiError.badRequest("This order is paid in cash on delivery");
  return { order, payment };
}

/** What the browser needs to open the gateway's checkout. */
function checkoutInfo(order, payment) {
  return {
    provider: payment.provider,
    simulated: payment.provider === mockProvider.name,
    keyId: online?.keyId,
    providerOrderId: payment.providerOrderId,
    amountPaise: payment.amountPaise,
    currency: payment.currency,
    orderNumber: order.orderNumber,
  };
}

/**
 * Creates (or reuses) the gateway order for an unpaid online order and returns
 * the checkout details. Safe to call again for "Pay now" retries.
 */
export async function startPayment(userId, orderId) {
  const { order, payment } = await loadForCustomer(userId, orderId);
  if (payment.status === P.PAID)
    throw conflict("This order is already paid", "ALREADY_PAID");
  if (order.status !== ORDER_STATUS.PENDING)
    throw conflict("This order can no longer be paid", "PAYMENT_CLOSED");
  if (!online || online.name !== payment.provider)
    throw unavailable("Online payment is not available right now");

  if (!payment.providerOrderId) {
    let created;
    try {
      created = await online.createOrder({
        amountPaise: payment.amountPaise,
        receipt: order.orderNumber,
        notes: { orderId: String(order._id) },
      });
    } catch (error) {
      logger.error(
        { err: error, orderId: String(order._id) },
        "Could not create gateway order",
      );
      throw unavailable(
        "The payment gateway is not responding. Please try again.",
      );
    }
    // Only the first concurrent caller stores its gateway order; others reuse it.
    await Payment.updateOne(
      { _id: payment._id, providerOrderId: null },
      { $set: { providerOrderId: created.providerOrderId } },
    );
    payment.providerOrderId = (
      await Payment.findById(payment._id).select("providerOrderId")
    ).providerOrderId;
  }
  return checkoutInfo(order, payment);
}

/**
 * The browser reports a completed Razorpay checkout. Verified twice: the HMAC
 * signature, then the payment itself fetched from Razorpay (status, amount, order).
 */
export async function confirmPayment(
  userId,
  orderId,
  { providerPaymentId, signature },
) {
  const { payment } = await loadForCustomer(userId, orderId);
  if (payment.status === P.PAID) return paymentView(payment); // duplicate callback
  if (payment.provider !== "razorpay" || online?.name !== "razorpay")
    throw ApiError.badRequest("This payment is not a Razorpay payment");
  if (
    !online.verifyCheckoutSignature({
      providerOrderId: payment.providerOrderId,
      providerPaymentId,
      signature,
    })
  ) {
    throw new ApiError(400, "Payment could not be verified", {
      code: "SIGNATURE_INVALID",
    });
  }
  let remote;
  try {
    remote = await online.fetchPayment(providerPaymentId);
  } catch (error) {
    logger.error({ err: error }, "Could not fetch payment from Razorpay");
    throw unavailable(
      "Could not confirm the payment yet. It will update automatically once confirmed.",
    );
  }
  if (
    remote.providerOrderId !== payment.providerOrderId ||
    remote.amountPaise !== payment.amountPaise
  ) {
    throw new ApiError(400, "Payment details do not match this order", {
      code: "PAYMENT_MISMATCH",
    });
  }
  if (remote.status === "captured" || remote.status === "authorized")
    return paymentView(await markPaid(payment._id, providerPaymentId));
  if (remote.status === "failed")
    return paymentView(await markFailed(payment._id, remote.failureReason));
  return paymentView(payment); // still processing: the webhook finishes it
}

/** Development only: finish a simulated payment with the outcome the tester chose. */
export async function completeMockPayment(userId, orderId, outcome) {
  const { order, payment } = await loadForCustomer(userId, orderId);
  if (payment.provider !== mockProvider.name || !env.payments.mockEnabled)
    throw ApiError.badRequest("This is not a simulated payment");
  if (order.status !== ORDER_STATUS.PENDING && payment.status !== P.PAID)
    throw conflict("This order can no longer be paid", "PAYMENT_CLOSED");
  if (!payment.providerOrderId)
    throw conflict("Start the payment first", "PAYMENT_NOT_STARTED");
  const updated =
    outcome === "success"
      ? await markPaid(
          payment._id,
          `mock_pay_${payment.providerOrderId.slice(-8)}`,
        )
      : await markFailed(payment._id, "Simulated failure");
  return paymentView(updated ?? payment);
}

/**
 * Razorpay webhook (raw body + X-Razorpay-Signature). Each event id is applied
 * once; replays and retries are acknowledged and ignored. Payment events mark the
 * payment paid or failed; refund events settle refunds the bank confirmed later.
 */
export async function handleRazorpayWebhook(rawBody, signature, eventId) {
  if (
    online?.name !== "razorpay" ||
    !online.verifyWebhookSignature(rawBody, signature)
  ) {
    throw new ApiError(400, "Invalid webhook signature", {
      code: "SIGNATURE_INVALID",
    });
  }
  const event = JSON.parse(rawBody);
  const kind = String(event.event ?? "");
  if (kind.startsWith("refund.")) {
    const entity = event.payload?.refund?.entity;
    const refund = entity?.id && (await Refund.findOne({ providerRefundId: entity.id }));
    if (!refund) return { ignored: true };
    const id = eventId || `${kind}:${entity.id}`;
    const claimed = await claimEvent({ _id: refund.payment }, id, kind);
    if (!claimed) return { duplicate: true };
    try {
      if (kind === "refund.processed") await finishRefund(refund, true);
      else if (kind === "refund.failed") await finishRefund(refund, false);
    } catch (error) {
      await releaseEvent(claimed._id, id);
      throw error;
    }
    return { processed: true };
  }

  const entity = event.payload?.payment?.entity;
  if (!entity?.order_id) return { ignored: true };
  const id = eventId || `${kind}:${entity.id}`;
  const payment = await claimEvent(
    { provider: "razorpay", providerOrderId: entity.order_id },
    id,
    kind,
  );
  if (!payment) return { duplicate: true };
  if (entity.amount !== payment.amountPaise) {
    logger.warn(
      { paymentId: String(payment._id) },
      "Webhook amount does not match the order",
    );
    return { ignored: true };
  }
  try {
    if (kind === "payment.captured" || kind === "payment.authorized")
      await markPaid(payment._id, entity.id);
    else if (kind === "payment.failed")
      await markFailed(payment._id, entity.error_description);
  } catch (error) {
    await releaseEvent(payment._id, id);
    throw error;
  }
  return { processed: true };
}

/** Records the event on the payment once; null when it was applied before (or no payment). */
function claimEvent(filter, id, kind) {
  return Payment.findOneAndUpdate(
    { ...filter, processedEvents: { $ne: id } },
    {
      $addToSet: { processedEvents: id },
      $push: { events: { eventId: id, type: kind, at: new Date() } },
    },
  );
}

/** Forgets an event whose processing failed, so the gateway's retry applies it. */
const releaseEvent = (paymentId, id) =>
  Payment.updateOne(
    { _id: paymentId },
    { $pull: { processedEvents: id, events: { eventId: id } } },
  ).catch((err) => logger.error({ err }, "Could not release webhook event"));

/**
 * Pending/failed -> paid, exactly once. The order then goes to the restaurant.
 * A real payment can still arrive after the order closed (e.g. it expired while the
 * customer was paying): it is recorded anyway, then refunded straight away.
 */
async function markPaid(paymentId, providerPaymentId) {
  const payment = await Payment.findOneAndUpdate(
    { _id: paymentId, status: { $in: [P.PENDING, P.FAILED, P.CANCELLED] } },
    {
      $set: {
        status: P.PAID,
        providerPaymentId,
        paidAt: new Date(),
        failureReason: null,
      },
    },
    { returnDocument: "after" },
  );
  if (!payment) return Payment.findById(paymentId);

  const order = await Order.findOneAndUpdate(
    { _id: payment.order, status: ORDER_STATUS.PENDING, submittedAt: null },
    { $set: { paymentStatus: P.PAID, submittedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (order) {
    logger.info(
      { orderId: order.id },
      "Online payment received; order sent to the restaurant",
    );
    await rewardEvents.orderPaid(order);
    await notifyNewOrder(order, "paid online");
  } else {
    // Paid after the order closed: refund straight away.
    const closed = await Order.findByIdAndUpdate(
      payment.order,
      { $set: { paymentStatus: P.PAID } },
      { returnDocument: "after" },
    );
    if (closed && CLOSED.includes(closed.status))
      await openRefund(payment, payment.amountPaise, {
        key: `order-closed:${closed._id}`,
        reason: "Paid after the order closed",
      });
  }
  return Payment.findById(paymentId);
}

async function markFailed(paymentId, reason) {
  const payment = await Payment.findOneAndUpdate(
    { _id: paymentId, status: P.PENDING },
    { $set: { status: P.FAILED, failureReason: reason || "Payment failed" } },
    { returnDocument: "after" },
  );
  if (payment)
    await Order.updateOne(
      { _id: payment.order, paymentStatus: P.PENDING },
      { $set: { paymentStatus: P.FAILED } },
    );
  return payment ?? Payment.findById(paymentId);
}

/**
 * Called when an order is rejected or cancelled. A paid online payment is refunded
 * in full (what is left of it), exactly once; an unpaid one is just closed.
 */
export async function settleCancelledPayment(order) {
  const payment = await Payment.findOne({ order: order._id });
  if (!payment) return;
  if (
    payment.method === PAYMENT_METHODS.ONLINE &&
    REFUNDABLE.includes(payment.status)
  ) {
    const remaining = payment.amountPaise - (payment.refundedPaise ?? 0);
    if (remaining > 0)
      await openRefund(payment, remaining, {
        key: `order-closed:${order._id}`,
        reason: `Order ${order.status}`,
      });
    return;
  }
  await Payment.updateOne(
    { _id: payment._id, status: { $in: [P.PENDING, P.FAILED] } },
    { $set: { status: P.CANCELLED } },
  );
  await Order.updateOne(
    { _id: order._id, paymentStatus: { $in: [P.PENDING, P.FAILED] } },
    { $set: { paymentStatus: P.CANCELLED } },
  );
}

// Refunds ---------------------------------------------------------------------------------------

const refundTooLarge = () =>
  new ApiError(409, "That is more than is left to refund", { code: "REFUND_TOO_LARGE" });

/** The provider that took this payment, if it is still configured. */
const providerOf = (payment) => {
  const provider = payment?.provider === mockProvider.name ? mockProvider : online;
  return provider?.name === payment?.provider ? provider : null;
};

/** Adds `amount` to the payment's refunded total unless that would pass the amount paid. */
const reserve = (paymentId, amount) =>
  Payment.findOneAndUpdate(
    {
      _id: paymentId,
      status: { $in: REFUNDABLE },
      $expr: {
        $lte: [{ $add: [{ $ifNull: ["$refundedPaise", 0] }, amount] }, "$amountPaise"],
      },
    },
    { $inc: { refundedPaise: amount } },
  );

/**
 * Records a refund and reserves its amount on the payment. Online refunds go to the gateway
 * straight away; cash refunds wait for finance to pay them back by hand. A repeated `key`
 * returns the first refund.
 */
async function openRefund(payment, amountPaise, { key, reason, by = null }) {
  const existing = await Refund.findOne({ idempotencyKey: key });
  if (existing) return existing;
  if (!(await reserve(payment._id, amountPaise))) throw refundTooLarge();
  const manual = payment.method === PAYMENT_METHODS.COD;
  let refund;
  try {
    refund = await Refund.create({
      payment: payment._id,
      order: payment.order,
      amountPaise,
      reason: reason?.slice(0, 300),
      idempotencyKey: key,
      requestedBy: by,
      status: manual ? R.MANUAL_PENDING : R.PENDING,
    });
  } catch (error) {
    await Payment.updateOne({ _id: payment._id }, { $inc: { refundedPaise: -amountPaise } });
    if (error.code === 11000) return Refund.findOne({ idempotencyKey: key }); // a racing twin
    throw error;
  }
  if (!manual) await processRefund(refund._id);
  return refund;
}

/** Sends a pending refund to the gateway. Never throws (failures are recorded and reported). */
export async function processRefund(refundId) {
  const refund = await Refund.findOneAndUpdate(
    { _id: refundId, status: R.PENDING },
    { $set: { status: R.PROCESSING } },
    { returnDocument: "after" },
  );
  if (!refund) return; // someone else took it
  const payment = await Payment.findById(refund.payment);
  let result;
  try {
    const provider = providerOf(payment);
    if (!provider || !payment.providerPaymentId)
      throw new Error(`Provider ${payment.provider} is not configured`);
    result = await provider.refund({
      providerPaymentId: payment.providerPaymentId,
      amountPaise: refund.amountPaise,
      receipt: String(refund._id),
    });
  } catch (error) {
    logger.error({ err: error, refundId: String(refund._id) }, "Refund failed");
    await finishRefund(refund, false);
    return;
  }
  await Refund.updateOne(
    { _id: refund._id },
    { $set: { providerRefundId: result.providerRefundId } },
  );
  if (result.status === "processed") await finishRefund(refund, true);
  else if (result.status === "failed") await finishRefund(refund, false);
  // else: the bank has not confirmed it yet; the webhook or reconciliation finishes it.
}

/** Exactly once per refund: done → the payment's status follows; failed → amount released. */
async function finishRefund(refund, ok) {
  const now = new Date();
  const done = await Refund.findOneAndUpdate(
    { _id: refund._id, status: { $in: REFUND_OPEN } },
    ok
      ? {
          $set: {
            status: refund.status === R.MANUAL_PENDING ? R.MANUAL_DONE : R.PROCESSED,
            processedAt: now,
            failureReason: null,
          },
        }
      : { $set: { status: R.FAILED, failureReason: REFUND_FAILED_NOTE } },
    { returnDocument: "after" },
  );
  if (!done) return;
  if (!ok)
    await Payment.updateOne(
      { _id: done.payment },
      {
        $inc: { refundedPaise: -done.amountPaise },
        $set: { failureReason: REFUND_FAILED_NOTE },
      },
    );
  else await syncPaymentStatus(done.payment, now, done.providerRefundId);
  const order = await Order.findById(done.order);
  logger.info(
    { orderId: String(done.order), refundId: String(done._id) },
    ok ? "Refund processed" : "Refund failed",
  );
  if (order) {
    await notifyRefund(order, done.amountPaise, ok);
    emitOrderUpdated(order);
  }
}

async function syncPaymentStatus(paymentId, now, providerRefundId) {
  const payment = await Payment.findById(paymentId);
  if (!payment || !REFUNDABLE.includes(payment.status)) return;
  const [row] = await Refund.aggregate([
    { $match: { payment: payment._id, status: { $in: REFUND_DONE } } },
    { $group: { _id: null, paise: { $sum: "$amountPaise" } } },
  ]);
  const refunded = row?.paise ?? 0;
  if (!refunded) return;
  const status = refunded >= payment.amountPaise ? P.REFUNDED : P.PARTIALLY_REFUNDED;
  await Payment.updateOne(
    { _id: payment._id },
    {
      $set: {
        status,
        refundedAt: now,
        ...(providerRefundId ? { providerRefundId } : {}),
        ...(status === P.REFUNDED ? { failureReason: null } : {}),
      },
    },
  );
  await Order.updateOne({ _id: payment.order }, { $set: { paymentStatus: status } });
}

/** A full or partial refund chosen by finance, up to what is left. */
export async function adminRefund(adminId, paymentId, { amountPaise, reason }, key) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw ApiError.notFound("Payment not found");
  if (!REFUNDABLE.includes(payment.status))
    throw ApiError.conflict("Only paid payments can be refunded", "NOT_REFUNDABLE");
  const left = payment.amountPaise - (payment.refundedPaise ?? 0);
  if (amountPaise > left)
    throw ApiError.validation([
      {
        field: "amountPaise",
        message: left
          ? `At most ${rupees(left)} can be refunded`
          : "Nothing is left to refund",
      },
    ]);
  await openRefund(payment, amountPaise, {
    key: `admin:${payment._id}:${key || crypto.randomUUID()}`,
    reason,
    by: adminId,
  });
  return adminGet(payment._id);
}

/** Sends failed refunds again, or refunds a paid payment of a closed order. */
export async function adminRetryRefund(paymentId) {
  const payment = await Payment.findById(paymentId).populate("order", "status");
  if (!payment) throw ApiError.notFound("Payment not found");
  const failed = await Refund.find({ payment: payment._id, status: R.FAILED });
  const closed = CLOSED.includes(payment.order?.status);
  const remaining = payment.amountPaise - (payment.refundedPaise ?? 0);
  if (!failed.length && !(REFUNDABLE.includes(payment.status) && closed && remaining > 0))
    throw ApiError.conflict(
      "Only paid payments of cancelled or rejected orders can be refunded",
      "NOT_REFUNDABLE",
    );
  await Payment.updateOne({ _id: payment._id }, { $set: { failureReason: null } });
  if (failed.length) {
    for (const refund of failed) {
      if (!(await reserve(payment._id, refund.amountPaise))) continue;
      const requeued = await Refund.findOneAndUpdate(
        { _id: refund._id, status: R.FAILED },
        { $set: { status: R.PENDING, failureReason: null } },
      );
      if (requeued) await processRefund(refund._id);
      else
        await Payment.updateOne(
          { _id: payment._id },
          { $inc: { refundedPaise: -refund.amountPaise } },
        );
    }
  } else {
    await settleCancelledPayment(payment.order);
  }
  return paymentView(await Payment.findById(payment._id));
}

/** Finance paid a cash-on-delivery refund back by hand. */
export async function adminCompleteManualRefund(refundId) {
  const refund = await Refund.findById(refundId);
  if (!refund) throw ApiError.notFound("Refund not found");
  if (refund.status !== R.MANUAL_PENDING)
    throw ApiError.conflict("This refund is not waiting to be paid by hand", "NOT_MANUAL");
  await finishRefund(refund, true);
  return adminGet(refund.payment);
}

// Views -----------------------------------------------------------------------------------------

/** The customer-safe view of a payment. */
export function paymentView(payment) {
  return {
    status: payment.status,
    method: payment.method,
    provider: payment.provider,
    simulated: payment.provider === mockProvider.name,
    amountPaise: payment.amountPaise,
    refundedPaise: payment.refundedPaise ?? 0,
    paidAt: payment.paidAt ?? null,
    refundedAt: payment.refundedAt ?? null,
    failureReason: payment.failureReason ?? null,
  };
}

export const refundJson = (r) => ({
  id: String(r._id),
  amountPaise: r.amountPaise,
  status: r.status,
  reason: r.reason || null,
  createdAt: r.createdAt,
  processedAt: r.processedAt ?? null,
});

/** The refunds of one payment, oldest first (customer order view and admin detail). */
export const refundsOf = async (paymentId) =>
  (await Refund.find({ payment: paymentId }).sort({ createdAt: 1 })).map(refundJson);

const refundNeeded = (p) =>
  p.method === PAYMENT_METHODS.ONLINE &&
  REFUNDABLE.includes(p.status) &&
  p.amountPaise > (p.refundedPaise ?? 0) &&
  CLOSED.includes(p.order?.status);

function adminRow(p) {
  return {
    id: String(p._id),
    ...paymentView(p),
    providerOrderId: p.providerOrderId ?? null,
    providerPaymentId: p.providerPaymentId ?? null,
    createdAt: p.createdAt,
    customer: p.user?.name
      ? { id: String(p.user._id), name: p.user.name, email: p.user.email }
      : null,
    order: p.order
      ? { id: String(p.order._id), orderNumber: p.order.orderNumber, status: p.order.status }
      : null,
    refundNeeded: refundNeeded(p),
    refundablePaise: REFUNDABLE.includes(p.status)
      ? p.amountPaise - (p.refundedPaise ?? 0)
      : 0,
  };
}

/**
 * All payments, newest first, filterable by status, method, provider, date and a search over the
 * order number and the customer's name, email or phone. Includes the order number and customer.
 */
export async function adminList(
  { status, method, provider, search, from, to },
  pagination,
) {
  const filter = {};
  if (status) filter.status = status;
  if (method) filter.method = method;
  if (provider) filter.provider = provider;
  if (from || to)
    filter.createdAt = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    const ids = (docs) => docs.map((d) => d._id);
    const [orders, users] = await Promise.all([
      Order.find({ orderNumber: pattern }).select("_id").limit(200).lean(),
      User.find({ $or: [{ name: pattern }, { email: pattern }, { phone: pattern }] })
        .select("_id")
        .limit(200)
        .lean(),
    ]);
    filter.$or = [{ order: { $in: ids(orders) } }, { user: { $in: ids(users) } }];
  }
  const [items, total] = await Promise.all([
    Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .populate("order", "orderNumber status")
      .populate("user", "name email"),
    Payment.countDocuments(filter),
  ]);
  return {
    items: items.map(adminRow),
    pagination: paginationMeta(pagination, total),
  };
}

/** One payment with its refunds and the gateway events applied to it (the audit trail). */
export async function adminGet(paymentId) {
  const payment = await Payment.findById(paymentId)
    .populate("order", "orderNumber status")
    .populate("user", "name email");
  if (!payment) throw ApiError.notFound("Payment not found");
  return {
    payment: {
      ...adminRow(payment),
      refunds: await refundsOf(payment._id),
      events: (payment.events ?? []).map((e) => ({
        type: e.type,
        eventId: e.eventId,
        createdAt: e.at,
      })),
    },
  };
}

/** The customer's payment history (abandoned checkout attempts are left out). */
export async function listMine(userId, pagination) {
  const abandoned = await Order.find({
    customer: userId,
    paymentMethod: PAYMENT_METHODS.ONLINE,
    submittedAt: null,
    status: ORDER_STATUS.CANCELLED,
  })
    .select("_id")
    .lean();
  const filter = { user: userId, order: { $nin: abandoned.map((o) => o._id) } };
  const [items, total] = await Promise.all([
    Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .populate("order", "orderNumber status restaurantSnapshot.name"),
    Payment.countDocuments(filter),
  ]);
  const refunds = await Refund.find({ payment: { $in: items.map((p) => p._id) } }).sort({
    createdAt: 1,
  });
  return {
    items: items.map((p) => ({
      id: String(p._id),
      ...paymentView(p),
      createdAt: p.createdAt,
      order: {
        id: String(p.order._id),
        orderNumber: p.order.orderNumber,
        status: p.order.status,
        restaurantName: p.order.restaurantSnapshot?.name ?? "",
      },
      refunds: refunds.filter((r) => String(r.payment) === String(p._id)).map(refundJson),
    })),
    pagination: paginationMeta(pagination, total),
  };
}

// Reconciliation --------------------------------------------------------------------------------

/**
 * Catches what the browser and the webhooks missed:
 * 1. unpaid online payments the gateway reports as captured (or failed);
 * 2. refunds whose gateway call never finished (the process stopped half-way);
 * 3. refunds the bank has not confirmed yet.
 */
export async function reconcile(now = new Date()) {
  const summary = { paid: 0, failed: 0, refundsSent: 0, refundsSettled: 0 };
  if (online) {
    const waiting = await Payment.find({
      method: PAYMENT_METHODS.ONLINE,
      provider: online.name,
      status: { $in: [P.PENDING, P.FAILED, P.CANCELLED] },
      providerOrderId: { $type: "string" },
      createdAt: {
        $lte: new Date(now - 2 * MINUTE),
        $gte: new Date(now - 24 * 60 * MINUTE),
      },
    })
      .sort({ createdAt: 1 })
      .limit(50);
    for (const payment of waiting) {
      let remote;
      try {
        remote = await online.orderPayments(payment.providerOrderId);
      } catch (error) {
        logger.error({ err: error }, "Reconciliation: gateway lookup failed");
        continue;
      }
      const captured = remote.find(
        (r) =>
          ["captured", "authorized"].includes(r.status) &&
          r.amountPaise === payment.amountPaise,
      );
      if (captured) {
        await markPaid(payment._id, captured.id);
        summary.paid += 1;
      } else if (
        payment.status === P.PENDING &&
        remote.length &&
        remote.every((r) => r.status === "failed")
      ) {
        await markFailed(payment._id, "Payment failed");
        summary.failed += 1;
      }
    }
  }

  const stuck = await Refund.find({
    status: R.PENDING,
    updatedAt: { $lte: new Date(now - 2 * MINUTE) },
  }).limit(50);
  for (const refund of stuck) {
    await processRefund(refund._id);
    summary.refundsSent += 1;
  }

  const unconfirmed = await Refund.find({
    status: R.PROCESSING,
    providerRefundId: { $type: "string" },
    updatedAt: { $lte: new Date(now - 5 * MINUTE) },
  }).limit(50);
  for (const refund of unconfirmed) {
    const payment = await Payment.findById(refund.payment);
    const provider = providerOf(payment);
    if (!provider) continue;
    let state;
    try {
      state = await provider.refundStatus(payment.providerPaymentId, refund.providerRefundId);
    } catch (error) {
      logger.error({ err: error }, "Reconciliation: refund lookup failed");
      continue;
    }
    if (state === "processed" || state === "failed") {
      await finishRefund(refund, state === "processed");
      summary.refundsSettled += 1;
    }
  }
  return summary;
}

/** Runs reconciliation every 5 minutes; returns a stop function (used on shutdown). */
export const startReconcileLoop = (intervalMs = 5 * MINUTE) =>
  startSweepLoop("Payments", () => reconcile(), intervalMs, (s) =>
    Object.values(s).some(Boolean),
  );
