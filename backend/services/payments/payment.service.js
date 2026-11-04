import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import {
  ORDER_STATUS,
  Order,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  Payment,
} from "../../models/order.model.js";
import { ApiError } from "../../utils/api-error.js";
import { paginationMeta } from "../../utils/pagination.js";
import { notifyNewOrder, notifyRefund } from "../order-notifications.js";
import { mockProvider } from "./mock.provider.js";
import { razorpayFromEnv } from "./razorpay.provider.js";

const P = PAYMENT_STATUS;
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
 * once; replays and retries are acknowledged and ignored.
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
  const entity = event.payload?.payment?.entity;
  if (!entity?.order_id) return { ignored: true };
  const id = eventId || `${event.event}:${entity.id}`;
  // Claim the event id atomically: only the first delivery of an event does anything.
  const payment = await Payment.findOneAndUpdate(
    {
      provider: "razorpay",
      providerOrderId: entity.order_id,
      processedEvents: { $ne: id },
    },
    { $addToSet: { processedEvents: id } },
  );
  if (!payment) return { duplicate: true };
  if (entity.amount !== payment.amountPaise) {
    logger.warn(
      { paymentId: String(payment._id) },
      "Webhook amount does not match the order",
    );
    return { ignored: true };
  }
  if (
    event.event === "payment.captured" ||
    event.event === "payment.authorized"
  )
    await markPaid(payment._id, entity.id);
  else if (event.event === "payment.failed")
    await markFailed(payment._id, entity.error_description);
  return { processed: true };
}

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
    await notifyNewOrder(order, "paid online");
  } else {
    // Paid after the order closed: refund straight away.
    const closed = await Order.findByIdAndUpdate(
      payment.order,
      { $set: { paymentStatus: P.PAID } },
      { returnDocument: "after" },
    );
    if (closed) await refundIfPaid(closed);
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
 * Called when an order is rejected or cancelled. Online payments that were paid
 * are refunded through the provider (exactly once); unpaid ones are just closed.
 */
export async function settleCancelledPayment(order) {
  if (
    order.paymentStatus === P.PAID &&
    order.paymentMethod === PAYMENT_METHODS.ONLINE
  )
    return refundIfPaid(order);
  await Payment.updateOne(
    { order: order._id, status: { $in: [P.PENDING, P.FAILED] } },
    { $set: { status: P.CANCELLED } },
  );
  await Order.updateOne(
    { _id: order._id, paymentStatus: { $in: [P.PENDING, P.FAILED] } },
    { $set: { paymentStatus: P.CANCELLED } },
  );
}

async function refundIfPaid(order) {
  // Claim the refund first so concurrent callers cannot refund twice.
  const payment = await Payment.findOneAndUpdate(
    {
      order: order._id,
      status: P.PAID,
      method: PAYMENT_METHODS.ONLINE,
      refundedAt: null,
    },
    { $set: { refundedAt: new Date() } },
  );
  if (!payment) return;
  const provider =
    payment.provider === mockProvider.name ? mockProvider : online;
  try {
    const { providerRefundId } = await provider.refund({
      providerPaymentId: payment.providerPaymentId,
      amountPaise: payment.amountPaise,
    });
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { status: P.REFUNDED, providerRefundId } },
    );
    await Order.updateOne(
      { _id: order._id },
      { $set: { paymentStatus: P.REFUNDED } },
    );
    logger.info({ orderId: String(order._id) }, "Payment refunded");
    await notifyRefund(order, payment.amountPaise, true);
  } catch (error) {
    // Leave it paid with the claim released, so an admin (or a retry) can refund it.
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          refundedAt: null,
          failureReason: "Refund failed; retry from the admin panel",
        },
      },
    );
    logger.error({ err: error, orderId: String(order._id) }, "Refund failed");
    await notifyRefund(order, payment.amountPaise, false);
  }
}

/** The customer-safe view of a payment. */
export function paymentView(payment) {
  return {
    status: payment.status,
    method: payment.method,
    provider: payment.provider,
    simulated: payment.provider === mockProvider.name,
    amountPaise: payment.amountPaise,
    paidAt: payment.paidAt ?? null,
    refundedAt: payment.refundedAt ?? null,
    failureReason: payment.failureReason ?? null,
  };
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** All payments, newest first, filterable by status, method and provider, with the order number. */
export async function adminList({ status, method, provider }, pagination) {
  const filter = {};
  if (status) filter.status = status;
  if (method) filter.method = method;
  if (provider) filter.provider = provider;
  const [items, total] = await Promise.all([
    Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .populate("order", "orderNumber status"),
    Payment.countDocuments(filter),
  ]);
  return {
    items: items.map((p) => ({
      id: String(p._id),
      ...paymentView(p),
      providerOrderId: p.providerOrderId ?? null,
      providerPaymentId: p.providerPaymentId ?? null,
      createdAt: p.createdAt,
      order: p.order
        ? {
            id: String(p.order._id),
            orderNumber: p.order.orderNumber,
            status: p.order.status,
          }
        : null,
      // Paid online, order closed, not refunded: a refund failed and needs a retry.
      refundNeeded:
        p.status === P.PAID &&
        p.method === PAYMENT_METHODS.ONLINE &&
        [ORDER_STATUS.CANCELLED, ORDER_STATUS.REJECTED].includes(
          p.order?.status,
        ),
    })),
    pagination: paginationMeta(pagination, total),
  };
}

/** Retry a refund that failed earlier (paid online, order closed). */
export async function adminRetryRefund(paymentId) {
  const payment = await Payment.findById(paymentId).populate(
    "order",
    "orderNumber customer status paymentMethod paymentStatus",
  );
  if (!payment) throw ApiError.notFound("Payment not found");
  const closed = [ORDER_STATUS.CANCELLED, ORDER_STATUS.REJECTED].includes(
    payment.order?.status,
  );
  if (payment.status !== P.PAID || !closed)
    throw conflict(
      "Only paid payments of cancelled or rejected orders can be refunded",
      "NOT_REFUNDABLE",
    );
  await refundIfPaid(payment.order);
  return paymentView(await Payment.findById(paymentId));
}
