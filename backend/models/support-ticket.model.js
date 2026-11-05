import mongoose from "mongoose";

export const TICKET_STATUS = Object.freeze({
  OPEN: "open",
  IN_PROGRESS: "in_progress",
  WAITING_FOR_RESPONSE: "waiting_for_response", // waiting for the person who raised it
  RESOLVED: "resolved",
  CLOSED: "closed",
});
export const TICKET_PRIORITY = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  URGENT: "urgent",
});
export const TICKET_TYPES = Object.freeze({
  ORDER_ISSUE: "order_issue",
  DELIVERY: "delivery",
  PAYMENT: "payment",
  REFUND: "refund",
  ACCOUNT: "account",
  OTHER: "other",
});
/** Who raised it: the ticket is a customer, restaurant or delivery partner complaint. */
export const REQUESTER_ROLES = Object.freeze(["customer", "restaurant", "delivery"]);
export const OPEN_TICKET_STATUSES = Object.freeze([
  TICKET_STATUS.OPEN,
  TICKET_STATUS.IN_PROGRESS,
  TICKET_STATUS.WAITING_FOR_RESPONSE,
]);

const messageSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    authorRole: { type: String, required: true },
    authorName: { type: String, required: true },
    body: { type: String, required: true, maxlength: 2000 },
    // Internal notes are only visible to support staff.
    internal: { type: Boolean, default: false },
    at: { type: Date, default: Date.now },
  },
  { _id: true },
);

const historySchema = new mongoose.Schema(
  {
    action: { type: String, required: true }, // created, status, priority, assigned, escalated
    from: String,
    to: String,
    note: { type: String, maxlength: 500 },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    byName: String,
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const supportTicketSchema = new mongoose.Schema(
  {
    number: { type: String, required: true },
    raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    requesterRole: { type: String, enum: REQUESTER_ROLES, required: true },
    requesterName: { type: String, required: true },
    type: { type: String, enum: Object.values(TICKET_TYPES), required: true },
    subject: { type: String, required: true, trim: true, maxlength: 120 },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    orderNumber: String,
    priority: {
      type: String,
      enum: Object.values(TICKET_PRIORITY),
      default: TICKET_PRIORITY.MEDIUM,
    },
    status: {
      type: String,
      enum: Object.values(TICKET_STATUS),
      default: TICKET_STATUS.OPEN,
    },
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    messages: { type: [messageSchema], default: [] },
    history: { type: [historySchema], default: [] },
    lastActivityAt: { type: Date, default: Date.now },
    resolvedAt: Date,
    closedAt: Date,
  },
  { timestamps: true },
);

supportTicketSchema.index({ number: 1 }, { unique: true });
supportTicketSchema.index({ status: 1, priority: 1, lastActivityAt: -1 });
supportTicketSchema.index({ requesterRole: 1, status: 1, lastActivityAt: -1 });
supportTicketSchema.index({ raisedBy: 1, lastActivityAt: -1 });
supportTicketSchema.index({ assignee: 1, status: 1 });
supportTicketSchema.index({ order: 1 });

export const SupportTicket = mongoose.model("SupportTicket", supportTicketSchema);
