import { OrderStatus, PaymentStatus } from './checkout.models';

export type PaymentMethod = 'cod' | 'online';
export type PaymentProvider = 'cash_on_delivery' | 'razorpay' | 'mock';

export interface PaymentMethodOption {
  method: PaymentMethod;
  label: string;
  provider: PaymentProvider;
  simulated: boolean;
}

export interface PaymentInfo {
  status: PaymentStatus;
  method: PaymentMethod;
  provider: PaymentProvider;
  simulated: boolean;
  amountPaise: number;
  paidAt: string | null;
  refundedAt: string | null;
  failureReason: string | null;
  /** Django API only: refunded so far (or under way), and the refunds themselves. */
  refundedPaise?: number;
  refunds?: RefundInfo[];
}

export type RefundStatus =
  'pending' | 'processing' | 'processed' | 'failed' | 'manual_pending' | 'manual_done';

export interface RefundInfo {
  id: string;
  amountPaise: number;
  status: RefundStatus;
  reason: string | null;
  createdAt: string;
  processedAt: string | null;
}

export const REFUND_STATUS_LABEL: Record<RefundStatus, string> = {
  pending: 'Starting',
  processing: 'With the bank',
  processed: 'Refunded',
  failed: 'Failed',
  manual_pending: 'To pay by hand',
  manual_done: 'Paid by hand',
};

const SETTLED = new Set<string>([
  'paid',
  'refunded',
  'partially_refunded',
  'processed',
  'manual_done',
]);

/** The `.bb-badge` tone class for a payment or refund status. */
export const paymentTone = (status: PaymentStatus | RefundStatus): string =>
  SETTLED.has(status)
    ? 'tone-good'
    : status === 'failed'
      ? 'tone-bad'
      : status === 'cancelled'
        ? ''
        : 'tone-warn';

/** One entry of the customer's payment history (`GET /payments/mine`). */
export interface PaymentHistoryItem extends PaymentInfo {
  id: string;
  createdAt: string;
  order: { id: string; orderNumber: string; status: OrderStatus; restaurantName: string };
  refunds: RefundInfo[];
}

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
  customer: { id: string; name: string; email: string } | null;
  refundNeeded: boolean;
  /** Django API only: what can still be refunded (absent on the Node API). */
  refundablePaise?: number;
}

/** `GET /admin/payments/:id` (Django API): the payment, its refunds and gateway events. */
export interface AdminPaymentDetail extends AdminPayment {
  refunds: RefundInfo[];
  events: { type: string; eventId: string; createdAt: string }[];
}

/** `GET /admin/payments?orderState=`: where the order stands (`cancelled` includes rejected). */
export type OrderState = 'active' | 'delivered' | 'cancelled';

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: 'Awaiting payment',
  paid: 'Paid',
  failed: 'Payment failed',
  refunded: 'Refunded',
  partially_refunded: 'Partly refunded',
  cancelled: 'Not charged',
};

export const PROVIDER_LABEL: Record<PaymentProvider, string> = {
  cash_on_delivery: 'Cash on delivery',
  razorpay: 'Razorpay',
  mock: 'Test payment',
};

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
