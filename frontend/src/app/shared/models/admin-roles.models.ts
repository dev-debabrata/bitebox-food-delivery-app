import { Paginated, Pagination } from './api.models';
import { OrderStatus, PaymentStatus } from './checkout.models';
import { PaymentInfo, PaymentMethod } from './payment.models';
import { AdminRole, StaffAdminRole, User, UserStatus } from './user.models';

// ---------------------------------------------------------------------------
// Admin management and audit log
// ---------------------------------------------------------------------------

export interface StaffAdminInput {
  name: string;
  email: string;
  phone?: string;
  password: string;
  role: StaffAdminRole;
}
export type StaffAdminUpdate = Partial<Pick<StaffAdminInput, 'name' | 'phone' | 'role'>>;
export interface StaffQuery {
  role?: AdminRole;
  status?: UserStatus;
  search?: string;
  page?: number;
  limit?: number;
}

export interface AuditEntry {
  id: string;
  admin: { id: string; name: string; email: string } | null;
  adminRole: AdminRole;
  action: string;
  description: string;
  resourceType?: string;
  resourceId?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface OperationsDashboard {
  days: number;
  orders: {
    total: number;
    completed: number;
    cancelled: number;
    pending: number;
    active: number;
    byStatus: Partial<Record<OrderStatus, number>>;
  };
  restaurants: { total: number; openNow: number; paused: number; awaitingApproval: number };
  riders: { total: number; online: number; busy: number };
}

export interface MonitoredOrder {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  restaurantName: string;
  rider: { id: string; name: string } | null;
  offeredTo: string | null;
  totalPaise: number;
  paymentMethod: PaymentMethod;
  placedAt: string;
  statusSince: string;
  minutesInStatus: number;
  late: boolean;
}
export interface Monitoring {
  items: MonitoredOrder[];
  lateAfterMinutes: Partial<Record<OrderStatus, number>>;
  at: string;
}

export interface RestaurantAvailability {
  id: string;
  name: string;
  slug: string;
  city?: string;
  isAcceptingOrders: boolean;
  isOpenNow: boolean;
  hours: string;
  activeOrders: number;
}

export interface DeliveryPerformance {
  days: number;
  totals: {
    delivered: number;
    avgDeliveryMinutes: number | null;
    avgPrepMinutes: number | null;
    avgPickupWaitMinutes: number | null;
    avgRideMinutes: number | null;
    within45Percent: number | null;
  };
  daily: { date: string; delivered: number; avgMinutes: number }[];
  topRiders: {
    id: string;
    name: string;
    deliveries: number;
    avgRideMinutes: number | null;
    distanceMeters: number;
  }[];
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export interface FinanceDashboard {
  days: number;
  totals: {
    revenuePaise: number;
    transactions: number;
    successfulPayments: number;
    failedPayments: number;
    pendingPayments: number;
    refunds: number;
    refundedPaise: number;
    platformCommissionPaise: number;
    restaurantEarningsPaise: number;
    riderEarningsPaise: number;
    pendingPayoutPaise: number;
    pendingPayoutBatches: number;
  };
  daily: { date: string; revenuePaise: number }[];
}

export interface Transaction extends PaymentInfo {
  id: string;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  providerRefundId: string | null;
  createdAt: string;
  customer: { id: string; name: string; email: string; phone: string | null } | null;
  order: {
    id: string;
    orderNumber: string;
    status: OrderStatus;
    restaurantName: string;
    pricing: {
      subtotalPaise: number;
      discountPaise: number;
      deliveryFeePaise: number;
      platformFeePaise: number;
      taxPaise: number;
      totalPaise: number;
    };
    settlement: {
      restaurantPaise: number;
      riderPaise: number;
      platformPaise: number;
      at: string;
    } | null;
    cancellation: { by: string; reason?: string } | null;
    paidOut: { restaurant: boolean; rider: boolean };
    createdAt: string;
  } | null;
}

export type PayoutType = 'restaurant' | 'rider';
export type PayoutStatus = 'pending' | 'paid' | 'cancelled';
export interface PayoutDue {
  payeeId: string;
  name: string;
  orders: number;
  amountPaise: number;
  from: string;
  to: string;
}
export interface Payout {
  id: string;
  type: PayoutType;
  payeeName: string;
  orders: number;
  amountPaise: number;
  periodFrom?: string;
  periodTo?: string;
  status: PayoutStatus;
  reference?: string;
  note?: string;
  paidAt?: string;
  createdAt: string;
}

export interface RefundRow extends PaymentInfo {
  id: string;
  refundNeeded: boolean;
  customer: { name: string; email: string } | null;
  order: { id: string; orderNumber: string; status: OrderStatus; reason: string | null } | null;
  updatedAt: string;
}

export interface Commission {
  days: number;
  rates: { restaurantCommissionPercent: number; riderBasePaise: number; riderPerKmPaise: number };
  totals: { orders: number; foodPaise: number; commissionPaise: number; platformPaise: number };
  items: {
    restaurantId: string;
    name: string;
    orders: number;
    foodPaise: number;
    commissionPaise: number;
    restaurantPaise: number;
    platformPaise: number;
  }[];
}

export interface CommissionRule {
  id: string;
  restaurant: { id: string; name: string } | null;
  basisPoints: number;
  percent: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
  createdBy: string | null;
}

/** `GET /admin/finance/commission/rules`. */
export interface CommissionRules {
  global: { basisPoints: number; percent: number; defaultBasisPoints: number };
  overrides: CommissionRule[];
  history: CommissionRule[];
}

export type LedgerAccount =
  | 'customer_payments'
  | 'restaurant_payable'
  | 'rider_payable'
  | 'platform_revenue'
  | 'tax_payable'
  | 'payouts';

/** `GET /admin/finance/ledger`: balances per account, the balance check and entries. */
export interface LedgerSummary {
  days: number;
  accounts: { account: LedgerAccount; balancePaise: number; periodPaise: number }[];
  balanced: boolean;
  unbalancedGroups: number;
  items: {
    id: string;
    group: string;
    account: LedgerAccount;
    amountPaise: number;
    description: string;
    orderNumber: string | null;
    createdAt: string;
  }[];
  pagination: Pagination;
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

export type TicketStatus = 'open' | 'in_progress' | 'waiting_for_response' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TicketType = 'order_issue' | 'delivery' | 'payment' | 'refund' | 'account' | 'other';
export type RequesterRole = 'customer' | 'restaurant' | 'delivery';

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_for_response: 'Waiting for response',
  resolved: 'Resolved',
  closed: 'Closed',
};
export const TICKET_PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};
export const TICKET_TYPE_LABEL: Record<TicketType, string> = {
  order_issue: 'Problem with an order',
  delivery: 'Delivery',
  payment: 'Payment',
  refund: 'Refund',
  account: 'My account',
  other: 'Something else',
};
export const REQUESTER_LABEL: Record<RequesterRole, string> = {
  customer: 'Customer',
  restaurant: 'Restaurant',
  delivery: 'Delivery partner',
};

/** What the person who raised the ticket sees (no internal notes, staff shown as "BiteBox Support"). */
export interface MyTicket {
  id: string;
  number: string;
  type: TicketType;
  subject: string;
  status: TicketStatus;
  orderNumber: string | null;
  createdAt: string;
  lastActivityAt: string;
  messages: { id: string; fromSupport: boolean; authorName: string; body: string; at: string }[];
}
export interface NewTicket {
  type: TicketType;
  subject: string;
  message: string;
  orderNumber?: string;
}

export interface TicketSummary {
  id: string;
  number: string;
  type: TicketType;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  requesterRole: RequesterRole;
  requesterName: string;
  orderNumber: string | null;
  assignee: { id: string; name: string } | null;
  messages: number;
  createdAt: string;
  lastActivityAt: string;
}
export interface TicketDetail extends Omit<TicketSummary, 'messages'> {
  requester: (Pick<User, 'id' | 'name' | 'email' | 'role'> & { phone: string | null }) | null;
  order: {
    id: string;
    orderNumber: string;
    status: OrderStatus;
    totalPaise: number;
    paymentMethod: PaymentMethod;
    paymentStatus: PaymentStatus;
    restaurantName: string;
    createdAt: string;
  } | null;
  messages: {
    id: string;
    authorName: string;
    authorRole: string;
    fromSupport: boolean;
    internal: boolean;
    body: string;
    at: string;
  }[];
  history: {
    action: string;
    from?: string;
    to?: string;
    note?: string;
    byName?: string;
    at: string;
  }[];
  resolvedAt: string | null;
  closedAt: string | null;
}
export interface TicketQuery {
  status?: TicketStatus | 'active';
  priority?: TicketPriority;
  requesterRole?: RequesterRole;
  type?: TicketType;
  assignee?: 'me' | 'unassigned';
  search?: string;
  page?: number;
  limit?: number;
}
export interface TicketUpdate {
  status?: TicketStatus;
  priority?: TicketPriority;
  assigneeId?: string | null;
}
export interface SupportDashboard {
  total: number;
  open: number;
  inProgress: number;
  pending: number;
  resolved: number;
  closed: number;
  highPriority: number;
  unassigned: number;
  openByRequester: Record<RequesterRole, number>;
  openRefundRequests: number;
}

export type TicketPage = Paginated<TicketSummary>;

/** Colour of a `.bb-badge`. */
export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

export const TICKET_STATUS_TONE: Record<TicketStatus, Tone> = {
  open: 'info',
  in_progress: 'warn',
  waiting_for_response: 'neutral',
  resolved: 'good',
  closed: 'neutral',
};
export const TICKET_PRIORITY_TONE: Record<TicketPriority, Tone> = {
  low: 'neutral',
  medium: 'info',
  high: 'warn',
  urgent: 'bad',
};
export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = {
  pending: 'Pending',
  paid: 'Paid',
  cancelled: 'Cancelled',
};
export const PAYOUT_STATUS_TONE: Record<PayoutStatus, Tone> = {
  pending: 'warn',
  paid: 'good',
  cancelled: 'neutral',
};

/** What each staff admin role can do, shown when a super admin picks a role. */
export const STAFF_ROLE_SUMMARY: Record<StaffAdminRole, string> = {
  operations_admin:
    'Orders (view, cancel, unassign), restaurant onboarding and approval, menu items, delivery partners, live monitoring and delivery reports.',
  finance_admin:
    'Transactions, refunds, restaurant and rider payouts, commission and financial reports. No order or account changes.',
  support_admin:
    'Support tickets from customers, restaurants and riders, review moderation, and read-only order details.',
};

/** GET /admin/dashboard. Money only for roles with finance:view. */
export interface PlatformSummary {
  customers: number;
  restaurants: number;
  approvedRestaurants: number;
  deliveryPartners: number;
  orders: { total: number; active: number; completed: number; cancelled: number };
  money?: {
    gmvPaise: number;
    platformRevenuePaise: number;
    pendingSettlementsPaise: number;
    pendingRestaurantPaise: number;
    pendingRiderPaise: number;
  };
}

/** One sign-in (a session family) from GET /admin/admins/{id}/logins. */
export interface LoginEntry {
  signedInAt: string;
  lastActiveAt: string;
  ip: string | null;
  userAgent: string;
  active: boolean;
  endedReason: string | null;
}
