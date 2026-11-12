import crypto from "node:crypto";
import Razorpay from "razorpay";
import { env } from "../../config/env.js";

/** Constant-time comparison of two hex HMACs (false on any length mismatch). */
function sameHmac(expectedHex, givenHex) {
  if (typeof givenHex !== "string" || givenHex.length !== expectedHex.length)
    return false;
  return crypto.timingSafeEqual(
    Buffer.from(expectedHex, "hex"),
    Buffer.from(givenHex, "hex"),
  );
}

const hmac = (secret, data) =>
  crypto.createHmac("sha256", secret).update(data).digest("hex");

export function createRazorpayProvider(
  { keyId, keySecret, webhookSecret },
  client = new Razorpay({ key_id: keyId, key_secret: keySecret }),
) {
  return {
    name: "razorpay",
    label: "Pay online (UPI, cards, netbanking)",
    simulated: false,
    keyId,

    async createOrder({ amountPaise, receipt, notes }) {
      const order = await client.orders.create({
        amount: amountPaise,
        currency: "INR",
        receipt,
        notes,
      });
      return {
        providerOrderId: order.id,
        amountPaise: order.amount,
        currency: order.currency,
      };
    },

    /** Checkout's handler response: razorpay_order_id | razorpay_payment_id signed with the key secret. */
    verifyCheckoutSignature({ providerOrderId, providerPaymentId, signature }) {
      return sameHmac(
        hmac(keySecret, `${providerOrderId}|${providerPaymentId}`),
        signature,
      );
    },

    /** { status: "captured" | "authorized" | "failed" | ..., amountPaise, providerOrderId, failureReason } */
    async fetchPayment(providerPaymentId) {
      const p = await client.payments.fetch(providerPaymentId);
      return {
        status: p.status,
        amountPaise: p.amount,
        providerOrderId: p.order_id,
        failureReason: p.error_description ?? null,
      };
    },

    async refund({ providerPaymentId, amountPaise }) {
      const refund = await client.payments.refund(providerPaymentId, {
        amount: amountPaise,
      });
      return { providerRefundId: refund.id };
    },

    /** Webhooks are signed over the exact raw request body with the webhook secret. */
    verifyWebhookSignature(rawBody, signature) {
      return (
        Boolean(webhookSecret) &&
        sameHmac(hmac(webhookSecret, rawBody), signature)
      );
    },
  };
}

/** The configured Razorpay provider, or null when its keys are not set. */
export const razorpayFromEnv = () =>
  env.payments.razorpayKeyId && env.payments.razorpayKeySecret
    ? createRazorpayProvider({
        keyId: env.payments.razorpayKeyId,
        keySecret: env.payments.razorpayKeySecret,
        webhookSecret: env.payments.razorpayWebhookSecret,
      })
    : null;
