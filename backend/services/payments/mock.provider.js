import crypto from "node:crypto";

export const mockProvider = {
  name: "mock",
  label: "Test payment (simulated, no real money)",
  simulated: true,

  async createOrder({ amountPaise }) {
    return {
      providerOrderId: `mock_order_${crypto.randomBytes(8).toString("hex")}`,
      amountPaise,
      currency: "INR",
    };
  },

  /** `receipt` is our refund id, so each (partial) refund gets its own gateway id. */
  async refund({ providerPaymentId, receipt }) {
    return {
      providerRefundId: `mock_refund_${receipt ?? providerPaymentId}`,
      status: "processed",
    };
  },

  async refundStatus() {
    return "processed";
  },

  /** Simulated payments finish only through the test dialog: nothing to reconcile. */
  async orderPayments() {
    return [];
  },
};
