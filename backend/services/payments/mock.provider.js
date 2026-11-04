import crypto from "node:crypto";

/**
 * Simulated gateway for local development ONLY. No money moves: the app shows
 * a "Simulated payment" dialog and the customer chooses success or failure.
 * Never enabled in production (see env.payments.mockEnabled).
 */
export const mockProvider = {
  name: "mock",
  label: "Test payment (simulated, no real money)",
  simulated: true,

  async createOrder({ amountPaise }) {
    return { providerOrderId: `mock_order_${crypto.randomBytes(8).toString("hex")}`, amountPaise, currency: "INR" };
  },

  async refund({ providerPaymentId }) {
    return { providerRefundId: `mock_refund_${providerPaymentId}` };
  },
};
