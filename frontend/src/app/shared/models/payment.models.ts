/** Payments, notifications, earnings and reports (Phase 6). Money is integer paise. */
import { OrderStatus, PaymentStatus } from './checkout.models';

export type PaymentMethod = 'cod' | 'online';
export type PaymentProvider = 'cash_on_delivery' | 'razorpay' | 'mock';

/** One choice at checkout, as offered by the server. */
export interface PaymentMethodOption {
  method: PaymentMethod;
  label: string;
  provider: PaymentProvider;
  /** The development-only test provider: no real money moves. */
  simulated: boolean;
}

/** The payment state shown with an order. */
export interface PaymentInfo {
  status: PaymentStatus;
  method: PaymentMethod;
  provider: PaymentProvider;
  simulated: boolean;
  amountPaise: number;
  paidAt: string | null;
  refundedAt: string | null;
  failureReason: string | null;
}

/** What the browser needs to open the gateway checkout. */
export interface CheckoutSession {
  provider: PaymentProvider;
  simulated: boolean;
  keyId?: string;
  providerOrderId: string;
  amountPaise: number;
  currency: string;
  orderNumber: string;
}

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  order?: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  items: AppNotification[];
  unread: number;
}

export interface EarningsDay {
  date: string;
  orders: number;
  earningsPaise: number;
}

export interface Earnings {
  days: number;
  totals: { orders: number; earningsPaise: number; distanceMeters: number };
  daily: EarningsDay[];
  recent: {
    id: string;
    orderNumber: string;
    restaurantName: string;
    area: string;
    totalPaise: number;
    distanceMeters: number;
    earningsPaise: number;
    deliveredAt: string;
  }[];
}

export interface AdminReport {
  days: number;
  totals: {
    orders: number;
    delivered: number;
    cancelled: number;
    gmvPaise: number;
    platformRevenuePaise: number;
    refundedPaise: number;
    averageOrderPaise: number;
    newCustomers: number;
  };
  daily: { date: string; orders: number; delivered: number; gmvPaise: number }[];
  paymentMix: { method: PaymentMethod; orders: number; paise: number }[];
  statusCounts: Partial<Record<OrderStatus, number>>;
  topRestaurants: { id: string; name: string; orders: number; gmvPaise: number }[];
}

export interface AdminPayment extends PaymentInfo {
  id: string;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  createdAt: string;
  order: { id: string; orderNumber: string; status: OrderStatus } | null;
  /** Paid online, order closed, not refunded: an earlier refund failed. */
  refundNeeded: boolean;
}

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: 'Awaiting payment',
  paid: 'Paid',
  failed: 'Payment failed',
  refunded: 'Refunded',
  cancelled: 'Not charged',
};

export const PROVIDER_LABEL: Record<PaymentProvider, string> = {
  cash_on_delivery: 'Cash on delivery',
  razorpay: 'Razorpay',
  mock: 'Test payment',
};

/** Icon per notification type (most specific first). */
const ICONS: [prefix: string, icon: string][] = [
  ['order.cancelled', 'cancel'],
  ['order.rejected', 'block'],
  ['order.delivered', 'task_alt'],
  ['order.offer', 'two_wheeler'],
  ['order.assigned', 'two_wheeler'],
  ['order.picked_up', 'local_shipping'],
  ['order.', 'receipt_long'],
  ['payment.', 'payments'],
  ['restaurant.', 'storefront'],
  ['user.', 'person_add'],
];

export const notificationIcon = (type: string): string =>
  ICONS.find(([prefix]) => type.startsWith(prefix))?.[1] ?? 'notifications';
