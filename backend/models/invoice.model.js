import mongoose from "mongoose";

export const INVOICE_KINDS = Object.freeze({
  CUSTOMER_TAX_INVOICE: "customer_tax_invoice", // an order's invoice for the customer
  PAYOUT_STATEMENT: "payout_statement", // what a restaurant or rider was paid, and for what
});

/** A numbered document (series per Indian financial year); the PDF is drawn on request. */
const invoiceSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: Object.values(INVOICE_KINDS), required: true },
    number: { type: String, required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    payout: { type: mongoose.Schema.Types.ObjectId, ref: "Payout", default: null },
    amountPaise: { type: Number, required: true },
    taxPaise: { type: Number, default: 0 },
    issuedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

invoiceSchema.index({ number: 1 }, { unique: true });
invoiceSchema.index({ order: 1 }, { unique: true, partialFilterExpression: { order: { $type: "objectId" } } });
invoiceSchema.index({ payout: 1 }, { unique: true, partialFilterExpression: { payout: { $type: "objectId" } } });

export const Invoice = mongoose.model("Invoice", invoiceSchema);

/** The last number used per series (e.g. "INV/2026-27"), taken with an atomic increment. */
export const InvoiceSequence = mongoose.model(
  "InvoiceSequence",
  new mongoose.Schema({ _id: String, last: { type: Number, default: 0 } }),
);
