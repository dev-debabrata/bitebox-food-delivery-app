import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe, DecimalPipe, formatDate } from '@angular/common';
import { ConfettiComponent, IconComponent, TimelineComponent, type TimelineEvent } from 'nexprime';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { EMPTY, catchError, firstValueFrom } from 'rxjs';
import { errorMessage } from '../../../core/services/api-error';
import { OrderService } from '../../../core/services/checkout-api.service';
import { PaymentService } from '../../../core/services/payment.service';
import { NotificationService } from '../../../core/services/notification.service';
import { etaMinutes } from '../../../core/services/routing.service';
import { liveRefresh } from '../../../core/services/poll';
import { confirmed } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { BillSummary } from '../../../shared/components/bill-summary/bill-summary';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { deliveryTracking } from '../../../shared/components/tracking-map/delivery-tracking';
import { TrackingMap } from '../../../shared/components/tracking-map/tracking-map';
import { VegBadge } from '../../../shared/components/veg-badge/veg-badge';
import {
  ORDER_STATUS_LABEL,
  Order,
  OrderStatus,
  VEHICLE_LABEL,
  awaitingPayment,
  customerStatusLabel,
} from '../../../shared/models/checkout.models';
import { PAYMENT_STATUS_LABEL, PROVIDER_LABEL } from '../../../shared/models/payment.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';

/** The happy-path journey shown as a progress tracker, with a NexPrime icon per step. */
const JOURNEY: { status: OrderStatus; icon: string }[] = [
  { status: 'pending', icon: 'receipt' },
  { status: 'confirmed', icon: 'circle-check' },
  { status: 'preparing', icon: 'chef-hat' },
  { status: 'ready_for_pickup', icon: 'package' },
  { status: 'picked_up', icon: 'bike' },
  { status: 'on_the_way', icon: 'navigation' },
  { status: 'delivered', icon: 'house' },
];

@Component({
  selector: 'bb-order-detail',
  imports: [
    DatePipe,
    RouterLink,
    MatButtonModule,
    IconComponent, NpIconPipe,
    BillSummary,
    EmptyState,
    VegBadge,
    InrPipe,
    TimelineComponent,
    ConfettiComponent,
    TrackingMap,
    DecimalPipe,
  ],
  templateUrl: './order-detail.html',
  styleUrl: './order-detail.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrderDetail {
  private readonly orders = inject(OrderService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);
  private readonly payments = inject(PaymentService);

  readonly id = input.required<string>();
  /** ?placed=1 right after checkout. */
  readonly placed = input<string>();

  protected readonly order = signal<Order | null>(null);
  protected readonly loading = signal(true);
  protected readonly notFound = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly statusLabel = customerStatusLabel;
  protected readonly paymentLabel = PAYMENT_STATUS_LABEL;
  protected readonly providerLabel = PROVIDER_LABEL;
  protected readonly paying = signal(false);
  /** Online order not paid yet: the restaurant has not received it. */
  protected readonly awaitingPayment = computed(() => {
    const o = this.order();
    return !!o && awaitingPayment(o);
  });
  protected readonly vehicleLabel = VEHICLE_LABEL;
  protected readonly cancelling = signal(false);
  /** Rider position, routes and estimates for the live map. */
  protected readonly tracking = deliveryTracking(this.order);
  protected readonly minutes = etaMinutes;

  private readonly locale = inject(LOCALE_ID);
  private readonly confetti = viewChild(ConfettiComponent);
  private celebrated = false;

  /** Index of the current step in JOURNEY ("assigned" shows as ready for pickup). */
  protected readonly activeStep = computed(() => {
    const status = this.order()?.status;
    if (!status) return -1;
    return JOURNEY.findIndex(
      (s) => s.status === (status === 'assigned' ? 'ready_for_pickup' : status),
    );
  });

  /** Steps for <np-timeline>: label, time reached (if any) and icon. */
  protected readonly timeline = computed<TimelineEvent[]>(() => {
    const order = this.order();
    if (!order) return [];
    return JOURNEY.map(({ status, icon }) => {
      const at = order.statusHistory.find((h) => h.status === status)?.at;
      return {
        status: ORDER_STATUS_LABEL[status],
        date: at ? formatDate(at, 'shortTime', this.locale) : '',
        icon,
      };
    });
  });

  protected readonly ended = computed(() => {
    const status = this.order()?.status;
    return status === 'cancelled' || status === 'rejected';
  });
  /** Still moving: worth refreshing. */
  private readonly inProgress = computed(() => {
    const status = this.order()?.status;
    return !!status && !this.ended() && status !== 'delivered';
  });

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => this.load(id));
    });

    // Live: reload as soon as the server says this order changed; a slow poll covers dropped connections.
    // Finished orders never change, so they are not reloaded (the first poll tick also skips: not loaded yet).
    // Events that repeat the status on screen (e.g. the echo of our own cancel) are skipped too.
    liveRefresh(
      () => (this.inProgress() ? this.orders.get(this.id()).pipe(catchError(() => EMPTY)) : EMPTY),
      {
        pollMs: 60_000,
        debounceMs: 0,
        // While unpaid, the payment confirmation arrives as an event with the same status.
        when: (e) =>
          e.id === this.id() && (e.status !== this.order()?.status || this.awaitingPayment()),
      },
    )
      .pipe(takeUntilDestroyed())
      .subscribe((order) => {
        const before = this.order()?.status;
        this.order.set(order);
        if (before && before !== order.status)
          this.notify.info(`Order ${ORDER_STATUS_LABEL[order.status].toLowerCase()}`);
      });
  }

  /** Customers may cancel until the restaurant accepts. */
  protected cancel(order: Order): void {
    confirmed(
      this.dialog,
      {
        title: 'Cancel this order?',
        message: `${order.restaurantSnapshot.name} has not accepted it yet, so you will not be charged.`,
        confirmLabel: 'Cancel order',
        danger: true,
      },
      '420px',
    ).subscribe(() => {
      this.cancelling.set(true);
      this.orders.cancel(order.id).subscribe({
        next: (updated) => {
          this.order.set(updated);
          this.cancelling.set(false);
          this.notify.success('Order cancelled');
        },
        error: (err: unknown) => {
          this.cancelling.set(false);
          this.notify.error(errorMessage(err));
          this.load();
        },
      });
    });
  }

  /** Opens the gateway again for an unpaid online order. */
  protected async payNow(order: Order): Promise<void> {
    this.paying.set(true);
    try {
      const session = await firstValueFrom(this.payments.start(order.id));
      const payment = await this.payments.pay(order.id, session);
      if (payment?.status === 'paid')
        this.notify.success(`Paid. ${order.restaurantSnapshot.name} has your order.`);
      else if (payment?.status === 'failed')
        this.notify.error(payment.failureReason ?? 'The payment failed. You can try again.');
    } catch (err: unknown) {
      this.notify.error(errorMessage(err, 'Payment could not be completed.'));
    } finally {
      this.paying.set(false);
      this.load(order.id, true);
    }
  }

  /** Confetti burst once, right after checkout (?placed=1). */
  private celebrate(): void {
    if (!this.placed() || this.celebrated) return;
    this.celebrated = true;
    // Wait a frame so the banner (and its canvas) is rendered and sized.
    setTimeout(() => this.confetti()?.fire(), 150);
  }

  /** `quiet` keeps the page on screen while re-reading (after a payment). */
  protected load(id = this.id(), quiet = false): void {
    if (!quiet) this.loading.set(true);
    this.error.set(null);
    this.orders.get(id).subscribe({
      next: (order) => {
        this.order.set(order);
        this.loading.set(false);
        this.celebrate();
      },
      error: (err: unknown) => {
        if (err instanceof HttpErrorResponse && (err.status === 404 || err.status === 422))
          this.notFound.set(true);
        else this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }
}
