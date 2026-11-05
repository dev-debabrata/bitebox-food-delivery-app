import { PERMISSIONS, hasPermission } from "../config/permissions.js";
import { Order } from "../models/order.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import {
  OPEN_TICKET_STATUSES,
  TICKET_PRIORITY,
  TICKET_STATUS,
  TICKET_TYPES,
  SupportTicket,
} from "../models/support-ticket.model.js";
import { ADMIN_ROLES, ROLES, USER_STATUS, User } from "../models/user.model.js";
import { ApiError } from "../utils/api-error.js";
import { randomCode } from "../utils/codes.js";
import { escapeRegex, paginationMeta } from "../utils/pagination.js";
import { notify, notifyAdmins } from "./notification.service.js";

const T = TICKET_STATUS;
const STATUS_LABEL = {
  [T.OPEN]: "Open",
  [T.IN_PROGRESS]: "In progress",
  [T.WAITING_FOR_RESPONSE]: "Waiting for your reply",
  [T.RESOLVED]: "Resolved",
  [T.CLOSED]: "Closed",
};
/** Where the person who raised a ticket reads it in the web app. */
const REQUESTER_LINK = {
  [ROLES.CUSTOMER]: (id) => `/support/${id}`,
  [ROLES.RESTAURANT]: (id) => `/restaurant/support/${id}`,
  [ROLES.DELIVERY]: (id) => `/delivery/support/${id}`,
};
const staffLink = (id) => `/admin/support/ticket/${id}`;
const isStaff = (role) => ADMIN_ROLES.includes(role);


/** The requester may only attach an order they placed, cooked or carried. */
async function ownOrder(user, orderNumber) {
  if (!orderNumber) return null;
  const scope = { orderNumber: orderNumber.toUpperCase() };
  if (user.role === ROLES.CUSTOMER) scope.customer = user._id;
  else if (user.role === ROLES.DELIVERY) scope.deliveryPartner = user._id;
  else {
    const restaurant = await Restaurant.findOne({ owner: user._id }).select("_id");
    scope.restaurant = restaurant?._id ?? null;
  }
  const order = await Order.findOne(scope).select("_id orderNumber");
  if (!order)
    throw new ApiError(422, "We could not find that order on your account", {
      code: "VALIDATION_ERROR",
      details: [{ field: "orderNumber", message: "No matching order on your account" }],
    });
  return order;
}

const historyEntry = (user, action, extra = {}) => ({
  action,
  by: user._id,
  byName: user.name,
  at: new Date(),
  ...extra,
});

function requesterView(ticket) {
  return {
    id: String(ticket._id),
    number: ticket.number,
    type: ticket.type,
    subject: ticket.subject,
    status: ticket.status,
    orderNumber: ticket.orderNumber ?? null,
    createdAt: ticket.createdAt,
    lastActivityAt: ticket.lastActivityAt,
    messages: ticket.messages
      .filter((m) => !m.internal)
      .map((m) => ({
        id: String(m._id),
        fromSupport: isStaff(m.authorRole),
        // Staff names stay private; requesters see "BiteBox Support".
        authorName: isStaff(m.authorRole) ? "BiteBox Support" : m.authorName,
        body: m.body,
        at: m.at,
      })),
  };
}

function staffSummary(ticket) {
  return {
    id: String(ticket._id),
    number: ticket.number,
    type: ticket.type,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    requesterRole: ticket.requesterRole,
    requesterName: ticket.requesterName,
    orderNumber: ticket.orderNumber ?? null,
    assignee: ticket.assignee?.name
      ? { id: String(ticket.assignee._id), name: ticket.assignee.name }
      : null,
    messages: ticket.messages?.length ?? 0,
    createdAt: ticket.createdAt,
    lastActivityAt: ticket.lastActivityAt,
  };
}

async function staffView(ticket) {
  await ticket.populate([
    { path: "assignee", select: "name" },
    { path: "raisedBy", select: "name email phone role" },
    {
      path: "order",
      select: "orderNumber status pricing.totalPaise paymentMethod paymentStatus restaurantSnapshot.name createdAt",
    },
  ]);
  const o = ticket.order;
  return {
    ...staffSummary(ticket),
    requester: ticket.raisedBy
      ? {
          id: String(ticket.raisedBy._id),
          name: ticket.raisedBy.name,
          email: ticket.raisedBy.email,
          phone: ticket.raisedBy.phone ?? null,
          role: ticket.raisedBy.role,
        }
      : null,
    order: o
      ? {
          id: String(o._id),
          orderNumber: o.orderNumber,
          status: o.status,
          totalPaise: o.pricing?.totalPaise,
          paymentMethod: o.paymentMethod,
          paymentStatus: o.paymentStatus,
          restaurantName: o.restaurantSnapshot?.name,
          createdAt: o.createdAt,
        }
      : null,
    messages: ticket.messages.map((m) => ({
      id: String(m._id),
      authorName: m.authorName,
      authorRole: m.authorRole,
      fromSupport: isStaff(m.authorRole),
      internal: m.internal,
      body: m.body,
      at: m.at,
    })),
    history: ticket.history,
    resolvedAt: ticket.resolvedAt ?? null,
    closedAt: ticket.closedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Customers, restaurants and riders
// ---------------------------------------------------------------------------

export async function create(user, { type, subject, message, orderNumber }) {
  const order = await ownOrder(user, orderNumber);
  const ticket = await SupportTicket.create({
    number: randomCode("TK"),
    raisedBy: user._id,
    requesterRole: user.role,
    requesterName: user.name,
    type,
    subject,
    order: order?._id ?? null,
    orderNumber: order?.orderNumber,
    // Money and safety problems go up the queue straight away.
    priority: [TICKET_TYPES.REFUND, TICKET_TYPES.PAYMENT].includes(type)
      ? TICKET_PRIORITY.HIGH
      : TICKET_PRIORITY.MEDIUM,
    messages: [{ author: user._id, authorRole: user.role, authorName: user.name, body: message }],
    history: [historyEntry(user, "created")],
  });
  await notifyAdmins(
    {
      type: "support.new",
      title: `New support ticket ${ticket.number}`,
      body: subject,
      link: staffLink(ticket._id),
    },
    PERMISSIONS.SUPPORT_MANAGE,
  );
  return requesterView(ticket);
}

export async function listMine(user, { status }, pagination) {
  const filter = { raisedBy: user._id };
  if (status === "open") filter.status = { $in: OPEN_TICKET_STATUSES };
  else if (status === "closed") filter.status = { $in: [T.RESOLVED, T.CLOSED] };
  const [items, total] = await Promise.all([
    SupportTicket.find(filter)
      .sort({ lastActivityAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .select("-messages -history"),
    SupportTicket.countDocuments(filter),
  ]);
  return {
    items: items.map((t) => ({ ...requesterView({ ...t.toObject(), messages: [] }) })),
    pagination: paginationMeta(pagination, total),
  };
}

async function findMine(user, id) {
  const ticket = await SupportTicket.findOne({ _id: id, raisedBy: user._id });
  if (!ticket) throw ApiError.notFound("Ticket not found");
  return ticket;
}

export const getMine = async (user, id) => requesterView(await findMine(user, id));

/** The requester replies. A resolved ticket reopens; a closed one needs a new ticket. */
export async function replyMine(user, id, body) {
  const ticket = await findMine(user, id);
  if (ticket.status === T.CLOSED)
    throw ApiError.badRequest("This ticket is closed. Please open a new one.");
  ticket.messages.push({ author: user._id, authorRole: user.role, authorName: user.name, body });
  const next = ticket.assignee ? T.IN_PROGRESS : T.OPEN;
  if (ticket.status !== next) {
    ticket.history.push(historyEntry(user, "status", { from: ticket.status, to: next }));
    ticket.status = next;
  }
  ticket.lastActivityAt = new Date();
  await ticket.save();
  const payload = {
    type: "support.reply",
    title: `New reply on ${ticket.number}`,
    body: body.slice(0, 140),
    link: staffLink(ticket._id),
  };
  if (ticket.assignee) await notify(ticket.assignee, payload);
  else await notifyAdmins(payload, PERMISSIONS.SUPPORT_MANAGE);
  return requesterView(ticket);
}

// ---------------------------------------------------------------------------
// Support staff
// ---------------------------------------------------------------------------

export async function dashboard() {
  const [byStatus, highPriority, unassigned, byRequester] = await Promise.all([
    SupportTicket.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    SupportTicket.countDocuments({
      status: { $in: OPEN_TICKET_STATUSES },
      priority: { $in: [TICKET_PRIORITY.HIGH, TICKET_PRIORITY.URGENT] },
    }),
    SupportTicket.countDocuments({
      status: { $in: OPEN_TICKET_STATUSES },
      assignee: null,
    }),
    SupportTicket.aggregate([
      { $match: { status: { $in: OPEN_TICKET_STATUSES } } },
      { $group: { _id: { role: "$requesterRole", type: "$type" }, n: { $sum: 1 } } },
    ]),
  ]);
  const counts = Object.fromEntries(byStatus.map((r) => [r._id, r.n]));
  const openBy = (match) =>
    byRequester.filter((r) => match(r._id)).reduce((n, r) => n + r.n, 0);
  return {
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    open: counts[T.OPEN] ?? 0,
    inProgress: counts[T.IN_PROGRESS] ?? 0,
    // Waiting on the customer, restaurant or rider to reply.
    pending: counts[T.WAITING_FOR_RESPONSE] ?? 0,
    resolved: counts[T.RESOLVED] ?? 0,
    closed: counts[T.CLOSED] ?? 0,
    highPriority,
    unassigned,
    openByRequester: {
      customer: openBy((k) => k.role === ROLES.CUSTOMER),
      restaurant: openBy((k) => k.role === ROLES.RESTAURANT),
      delivery: openBy((k) => k.role === ROLES.DELIVERY),
    },
    openRefundRequests: openBy((k) => k.type === TICKET_TYPES.REFUND),
  };
}

export async function list(staff, query, pagination) {
  const filter = {};
  if (query.status === "active") filter.status = { $in: OPEN_TICKET_STATUSES };
  else if (query.status) filter.status = query.status;
  if (query.priority) filter.priority = query.priority;
  if (query.requesterRole) filter.requesterRole = query.requesterRole;
  if (query.type) filter.type = query.type;
  if (query.assignee === "me") filter.assignee = staff._id;
  else if (query.assignee === "unassigned") filter.assignee = null;
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), "i");
    filter.$or = [
      { number: pattern },
      { subject: pattern },
      { orderNumber: pattern },
      { requesterName: pattern },
    ];
  }
  const [items, total] = await Promise.all([
    SupportTicket.find(filter)
      .sort({ lastActivityAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .select("-history")
      .populate("assignee", "name"),
    SupportTicket.countDocuments(filter),
  ]);
  return { items: items.map(staffSummary), pagination: paginationMeta(pagination, total) };
}

async function findTicket(id) {
  const ticket = await SupportTicket.findById(id);
  if (!ticket) throw ApiError.notFound("Ticket not found");
  return ticket;
}

export const get = async (id) => staffView(await findTicket(id));

/** People a ticket can be assigned to: active admins with the support permission. */
export async function staffList() {
  const roles = ADMIN_ROLES.filter((r) => hasPermission(r, PERMISSIONS.SUPPORT_MANAGE));
  const users = await User.find({ role: { $in: roles }, status: USER_STATUS.ACTIVE })
    .sort({ name: 1 })
    .select("name role");
  return { items: users.map((u) => ({ id: String(u._id), name: u.name, role: u.role })) };
}

/** Status, priority and assignee changes, each recorded in the ticket history. */
export async function update(staff, id, { status, priority, assigneeId, note }) {
  const ticket = await findTicket(id);
  const changes = [];
  if (status && status !== ticket.status) {
    changes.push(historyEntry(staff, "status", { from: ticket.status, to: status, note }));
    ticket.status = status;
    if (status === T.RESOLVED) ticket.resolvedAt = new Date();
    if (status === T.CLOSED) ticket.closedAt = new Date();
  }
  if (priority && priority !== ticket.priority) {
    changes.push(historyEntry(staff, "priority", { from: ticket.priority, to: priority }));
    ticket.priority = priority;
  }
  if (assigneeId !== undefined) {
    const current = ticket.assignee ? String(ticket.assignee) : null;
    if ((assigneeId || null) !== current) {
      let assignee = null;
      if (assigneeId) {
        assignee = await User.findOne({
          _id: assigneeId,
          status: USER_STATUS.ACTIVE,
          role: { $in: ADMIN_ROLES },
        }).select("name role");
        if (!assignee || !hasPermission(assignee.role, PERMISSIONS.SUPPORT_MANAGE))
          throw ApiError.badRequest("Assign the ticket to an active support admin");
      }
      changes.push(historyEntry(staff, "assigned", { to: assignee?.name ?? "Unassigned" }));
      ticket.assignee = assignee?._id ?? null;
      if (assignee && String(assignee._id) !== String(staff._id))
        await notify(assignee._id, {
          type: "support.assigned",
          title: `Ticket ${ticket.number} assigned to you`,
          body: ticket.subject,
          link: staffLink(ticket._id),
        });
    }
  }
  if (!changes.length) return staffView(ticket);
  ticket.history.push(...changes);
  ticket.lastActivityAt = new Date();
  await ticket.save();
  if (status && [T.RESOLVED, T.WAITING_FOR_RESPONSE, T.CLOSED].includes(status))
    await notify(ticket.raisedBy, {
      type: "support.status",
      title: `Ticket ${ticket.number}: ${STATUS_LABEL[status]}`,
      body: ticket.subject,
      link: REQUESTER_LINK[ticket.requesterRole](ticket._id),
    });
  return staffView(ticket);
}

/**
 * A staff reply or internal note. A reply to the requester moves the ticket to "waiting for
 * response" (unless it is already resolved or closed) and notifies them; notes notify nobody.
 */
export async function addMessage(staff, id, { body, internal = false }) {
  const ticket = await findTicket(id);
  if (ticket.status === T.CLOSED && !internal)
    throw ApiError.badRequest("Reopen the ticket before replying");
  ticket.messages.push({
    author: staff._id,
    authorRole: staff.role,
    authorName: staff.name,
    body,
    internal,
  });
  if (!internal && OPEN_TICKET_STATUSES.includes(ticket.status) && ticket.status !== T.WAITING_FOR_RESPONSE) {
    ticket.history.push(
      historyEntry(staff, "status", { from: ticket.status, to: T.WAITING_FOR_RESPONSE }),
    );
    ticket.status = T.WAITING_FOR_RESPONSE;
  }
  if (!ticket.assignee) ticket.assignee = staff._id; // whoever answers first owns it
  ticket.lastActivityAt = new Date();
  await ticket.save();
  if (!internal)
    await notify(ticket.raisedBy, {
      type: "support.reply",
      title: `BiteBox Support replied on ${ticket.number}`,
      body: body.slice(0, 140),
      link: REQUESTER_LINK[ticket.requesterRole](ticket._id),
    });
  return staffView(ticket);
}

/** Sends a refund or payment problem to the finance team (they get a notification). */
export async function escalateToFinance(staff, id, note) {
  const ticket = await findTicket(id);
  ticket.history.push(historyEntry(staff, "escalated", { to: "finance", note }));
  ticket.messages.push({
    author: staff._id,
    authorRole: staff.role,
    authorName: staff.name,
    body: `Escalated to finance: ${note}`,
    internal: true,
  });
  ticket.lastActivityAt = new Date();
  await ticket.save();
  await notifyAdmins(
    {
      type: "support.escalated",
      title: `Refund/payment issue from support (${ticket.number})`,
      body: `${ticket.orderNumber ? `Order ${ticket.orderNumber}: ` : ""}${note}`.slice(0, 200),
      link: "/admin/finance/refunds",
    },
    PERMISSIONS.REFUNDS_MANAGE,
  );
  return staffView(ticket);
}
