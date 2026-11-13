import { env } from "../config/env.js";
import { INVOICE_KINDS, Invoice, InvoiceSequence } from "../models/invoice.model.js";
import { ORDER_STATUS, Order } from "../models/order.model.js";
import { PAYOUT_TYPES } from "../models/payout.model.js";
import { ApiError } from "../utils/api-error.js";
import { Pdf } from "../utils/pdf.js";

/**
 * Downloadable PDFs (same as backend-django/apps/finance/invoices.py): the customer's invoice
 * for a delivered order and a partner's payout statement. A document gets its number the first
 * time it is produced, from a series per Indian financial year (e.g. BB/INV/2026-27/000042).
 *
 * Legal note (flagged for review by a qualified professional): a GST tax invoice also needs the
 * supplier's GSTIN, HSN/SAC codes and the CGST/SGST or IGST split; those come with restaurant KYC.
 */
const SERIES = { [INVOICE_KINDS.CUSTOMER_TAX_INVOICE]: "INV", [INVOICE_KINDS.PAYOUT_STATEMENT]: "STM" };
const LEFT = 48;
const RIGHT = 547;

const localParts = (at) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: env.reportTimezone,
      year: "numeric",
      month: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  );

export function financialYear(at) {
  const { year, month } = localParts(at);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
}

async function issue(kind, amountPaise, taxPaise, target) {
  const existing = await Invoice.findOne({ kind, ...target });
  if (existing) return existing;
  const now = new Date();
  const series = `${SERIES[kind]}/${financialYear(now)}`;
  const { last } = await InvoiceSequence.findByIdAndUpdate(
    series,
    { $inc: { last: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  try {
    return await Invoice.create({
      kind,
      number: `BB/${series}/${String(last).padStart(6, "0")}`,
      amountPaise,
      taxPaise,
      issuedAt: now,
      ...target,
    });
  } catch (error) {
    if (error?.code === 11000) return Invoice.findOne({ kind, ...target }); // a parallel request
    throw error;
  }
}

export const rs = (paise) => `${paise < 0 ? "-" : ""}Rs. ${(Math.abs(paise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (at) =>
  at
    ? new Intl.DateTimeFormat("en-GB", { timeZone: env.reportTimezone, day: "2-digit", month: "short", year: "numeric" }).format(at)
    : "-";

function header(pdf, title, number, issued) {
  pdf.text(LEFT, 60, "BiteBox", { size: 22, bold: true });
  pdf.text(RIGHT, 52, title, { size: 14, bold: true, right: true });
  pdf.text(RIGHT, 70, `No. ${number}`, { size: 9, right: true });
  pdf.text(RIGHT, 84, `Date ${when(issued)}`, { size: 9, right: true });
  pdf.line(LEFT, 100, RIGHT, { width: 1, grey: 0.2 });
}

/** Column headings ([x, label, right-aligned?]), then one line per row, starting a new page past
 * `bottom`; returns the y below the table. */
function table(pdf, y, columns, rows, bottom) {
  for (const [x, label, right] of columns) pdf.text(x, y, label, { size: 9, bold: true, right });
  pdf.line(LEFT, y + 6, RIGHT);
  y += 22;
  for (const cells of rows) {
    if (y > bottom) {
      pdf.newPage();
      y = 60;
    }
    columns.forEach(([x, , right], i) => pdf.text(x, y, cells[i], { right }));
    y += 18;
  }
  pdf.line(LEFT, y - 6, RIGHT);
  return y;
}

function totals(pdf, y, rows) {
  rows.forEach(([label, value], i) => {
    const bold = i === rows.length - 1;
    pdf.text(330, y, label, { bold });
    pdf.text(RIGHT, y, value, { bold, right: true });
    y += 16;
  });
  return y;
}

/** { name, pdf } for a delivered order. */
export async function orderInvoice(order) {
  if (order.status !== ORDER_STATUS.DELIVERED)
    throw ApiError.conflict("An invoice is available once the order is delivered", "NOT_DELIVERED");
  const p = order.pricing;
  const invoice = await issue(INVOICE_KINDS.CUSTOMER_TAX_INVOICE, p.totalPaise, p.taxPaise ?? 0, { order: order._id });
  const pdf = new Pdf();
  header(pdf, "Tax invoice", invoice.number, invoice.issuedAt);
  const snap = order.restaurantSnapshot ?? {};
  const a = order.deliveryAddress ?? {};
  pdf.text(LEFT, 124, "Sold by", { size: 9, bold: true });
  pdf.text(LEFT, 138, snap.name ?? "");
  pdf.text(LEFT, 152, snap.address ?? "", { size: 9 });
  pdf.text(320, 124, "Billed to", { size: 9, bold: true });
  pdf.text(320, 138, a.recipientName ?? "");
  pdf.text(320, 152, [a.line1, a.area].filter(Boolean).join(", "), { size: 9 });
  pdf.text(320, 166, [a.city, a.postalCode].filter(Boolean).join(", "), { size: 9 });
  pdf.text(LEFT, 190, `Order ${order.orderNumber} - placed ${when(order.createdAt)}`, { size: 9 });
  let y = table(
    pdf,
    220,
    [[LEFT, "Item"], [380, "Qty", true], [460, "Price", true], [RIGHT, "Amount", true]],
    order.items.map((i) => [i.name.slice(0, 60), i.quantity, rs(i.unitPricePaise), rs(i.lineTotalPaise)]),
    720,
  );
  const rows = [["Food", rs(p.subtotalPaise)]];
  if (p.discountPaise) rows.push(["Discount", rs(-p.discountPaise)]);
  rows.push(["Delivery fee", rs(p.deliveryFeePaise)], ["Platform fee", rs(p.platformFeePaise)], ["GST", rs(p.taxPaise ?? 0)]);
  if (p.coinDiscountPaise) rows.push(["Paid with coins", rs(-p.coinDiscountPaise)]);
  rows.push(["Total", rs(p.totalPaise)]);
  y = totals(pdf, y + 12, rows);
  pdf.text(LEFT, y + 10, `Payment: ${order.paymentMethod === "cod" ? "cash on delivery" : "online"}`, { size: 9 });
  pdf.text(LEFT, 780, "GSTIN, HSN/SAC codes and the CGST/SGST split are added once the restaurant's KYC is complete.", { size: 8 });
  return { name: `BiteBox-invoice-${order.orderNumber}.pdf`, pdf: pdf.render() };
}

/** { name, pdf }: what a payout covered, order by order. */
export async function payoutStatement(payout) {
  const invoice = await issue(INVOICE_KINDS.PAYOUT_STATEMENT, payout.amountPaise, 0, { payout: payout._id });
  const restaurant = payout.type === PAYOUT_TYPES.RESTAURANT;
  const pdf = new Pdf();
  header(pdf, "Payout statement", invoice.number, invoice.issuedAt);
  pdf.text(LEFT, 124, "Paid to", { size: 9, bold: true });
  pdf.text(LEFT, 138, payout.payeeName, { size: 11, bold: true });
  pdf.text(LEFT, 152, restaurant ? "Restaurant" : "Delivery partner", { size: 9 });
  pdf.text(320, 124, "Status", { size: 9, bold: true });
  pdf.text(320, 138, payout.status[0].toUpperCase() + payout.status.slice(1));
  pdf.text(320, 152, `Period ${when(payout.periodFrom)} to ${when(payout.periodTo)}`, { size: 9 });
  if (payout.reference) pdf.text(320, 166, `Bank reference ${payout.reference}`, { size: 9 });
  const orders = await Order.find({ [restaurant ? "payouts.restaurant" : "payouts.rider"]: payout._id })
    .sort({ "settlement.at": 1 })
    .select("orderNumber pricing settlement")
    .lean();
  // Restaurants also see the commission and refund deductions per order.
  const columns = restaurant
    ? [[LEFT, "Order"], [200, "Delivered"], [380, "Commission", true], [460, "Refunds", true], [RIGHT, "Amount", true]]
    : [[LEFT, "Order"], [200, "Delivered"], [RIGHT, "Amount", true]];
  const rows = orders.map(({ orderNumber, pricing, settlement: s }) => {
    const adj = s.refundAdjustmentPaise ?? 0;
    if (!restaurant) return [orderNumber, when(s.at), rs(s.riderPaise)];
    const food = pricing.subtotalPaise - (pricing.discountPaise ?? 0);
    return [orderNumber, when(s.at), rs(food - s.restaurantPaise), adj ? rs(-adj) : "-", rs(s.restaurantPaise - adj)];
  });
  const y = table(pdf, 200, columns, rows, 740);
  totals(pdf, y + 12, [["Orders", String(payout.orders)], ["Total paid", rs(payout.amountPaise)]]);
  return { name: `BiteBox-payout-${invoice.number.replace(/\//g, "-")}.pdf`, pdf: pdf.render() };
}
