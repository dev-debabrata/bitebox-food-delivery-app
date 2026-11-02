import { ChangeDetectionStrategy, Component, LOCALE_ID, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe, DecimalPipe, TitleCasePipe, formatDate } from '@angular/common';
import { ConfettiComponent, TimelineComponent, type TimelineEvent } from 'nexprime';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { EMPTY, catchError, filter, merge, switchMap } from 'rxjs';
import { errorMessage } from '../../../core/services/api-error';
import { OrderService } from '../../../core/services/checkout-api.service';
import { NotificationService } from '../../../core/services/notification.service';
import { pollWhileVisible } from '../../../core/services/poll';
import { RealtimeService } from '../../../core/services/realtime.service';
import { ConfirmDialog, ConfirmDialogData } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { BillSummary } from '../../../shared/components/bill-summary/bill-summary';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { deliveryTracking } from '../../../shared/components/tracking-map/delivery-tracking';
import { TrackingMap } from '../../../shared/components/tracking-map/tracking-map';
import { VegBadge } from '../../../shared/components/veg-badge/veg-badge';
import { ORDER_STATUS_LABEL, Order, OrderStatus, VEHICLE_LABEL } from '../../../shared/models/checkout.models';
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
    TitleCasePipe,
    RouterLink,
    MatButtonModule,
    MatIconModule,
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

  readonly id = input.required<string>();
  /** ?placed=1 right after checkout. */
  readonly placed = input<string>();

  protected readonly order = signal<Order | null>(null);
  protected readonly loading = signal(true);
  protected readonly notFound = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly statusLabel = ORDER_STATUS_LABEL;
  protected readonly vehicleLabel = VEHICLE_LABEL;
  protected readonly cancelling = signal(false);
  /** Rider position, routes and estimates for the live map. */
  protected readonly tracking = deliveryTracking(this.order);
  protected readonly minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

  private readonly locale = inject(LOCALE_ID);
  private readonly confetti = viewChild(ConfettiComponent);
  private celebrated = false;

  /** Index of the current step in JOURNEY ("assigned" shows as ready for pickup). */
  protected readonly activeStep = computed(() => {
    const status = this.order()?.status;
    if (!status) return -1;
    return JOURNEY.findIndex((s) => s.status === (status === 'assigned' ? 'ready_for_pickup' : status));
  });

  /** Steps for <np-timeline>: label, time reached (if any) and icon. */
  protected readonly timeline = computed<TimelineEvent[]>(() => {
    const order = this.order();
    if (!order) return [];
    return JOURNEY.map(({ status, icon }) => {
      const at = order.statusHistory.find((h) => h.status === status)?.at;
      return { status: ORDER_STATUS_LABEL[status], date: at ? formatDate(at, 'shortTime', this.locale) : '', icon };
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
    const reload = () => this.orders.get(this.id()).pipe(catchError(() => EMPTY));
    merge(
      inject(RealtimeService).orderUpdates$.pipe(
        filter((e) => e.id === this.id()),
        switchMap(reload),
      ),
      // (The first tick yields nothing because the order is not loaded yet.)
      pollWhileVisible(() => (this.inProgress() ? reload() : EMPTY), 60_000),
    )
      .pipe(takeUntilDestroyed())
      .subscribe((order) => {
        const before = this.order()?.status;
        this.order.set(order);
        if (before && before !== order.status) this.notify.info(`Order ${ORDER_STATUS_LABEL[order.status].toLowerCase()}`);
      });
  }

  /** Customers may cancel until the restaurant accepts. */
  protected cancel(order: Order): void {
    this.dialog
      .open<ConfirmDialog, ConfirmDialogData, true>(ConfirmDialog, {
        data: { title: 'Cancel this order?', message: `${order.restaurantSnapshot.name} has not accepted it yet, so you will not be charged.`, confirmLabel: 'Cancel order', danger: true },
        width: '420px',
      })
      .afterClosed()
      .pipe(filter(Boolean))
      .subscribe(() => {
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

  /** Confetti burst once, right after checkout (?placed=1). */
  private celebrate(): void {
    if (!this.placed() || this.celebrated) return;
    this.celebrated = true;
    // Wait a frame so the banner (and its canvas) is rendered and sized.
    setTimeout(() => this.confetti()?.fire(), 150);
  }

  protected load(id = this.id()): void {
    this.loading.set(true);
    this.error.set(null);
    this.orders.get(id).subscribe({
      next: (order) => {
        this.order.set(order);
        this.loading.set(false);
        this.celebrate();
      },
      error: (err: unknown) => {
        if (err instanceof HttpErrorResponse && (err.status === 404 || err.status === 422)) this.notFound.set(true);
        else this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }
}
