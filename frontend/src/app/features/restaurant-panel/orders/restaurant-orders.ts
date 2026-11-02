import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { filter, interval } from 'rxjs';
import { errorMessage } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { RestaurantOrdersService } from '../../../core/services/order-management.service';
import { RestaurantOrderBoard } from '../../../core/services/restaurant-order-board';
import { ConfirmDialog, ConfirmDialogData } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { OrderStatusChip } from '../../../shared/components/order-status-chip/order-status-chip';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { VegBadge } from '../../../shared/components/veg-badge/veg-badge';
import { OrderStatus } from '../../../shared/models/checkout.models';
import { RestaurantAction, RestaurantOrder, RestaurantOrderHistory } from '../../../shared/models/order-management.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';

type Tab = 'new' | 'preparing' | 'ready' | 'out' | 'history';

const TABS: { id: Tab; label: string; statuses: OrderStatus[] }[] = [
  { id: 'new', label: 'New', statuses: ['pending'] },
  { id: 'preparing', label: 'Preparing', statuses: ['confirmed', 'preparing'] },
  { id: 'ready', label: 'Ready for pickup', statuses: ['ready_for_pickup', 'assigned'] },
  { id: 'out', label: 'Out for delivery', statuses: ['picked_up', 'on_the_way'] },
  { id: 'history', label: 'History', statuses: [] },
];

/** Must match the backend's DISPATCH.restaurantResponseMinutes (unanswered orders auto-reject). */
const RESPONSE_MINUTES = 10;

/** The next step a restaurant can take for each status (rejecting is offered separately on new orders). */
const NEXT: Partial<Record<OrderStatus, { action: RestaurantAction; label: string; icon: string }>> = {
  pending: { action: 'confirmed', label: 'Accept', icon: 'check' },
  confirmed: { action: 'preparing', label: 'Start preparing', icon: 'skillet' },
  preparing: { action: 'ready_for_pickup', label: 'Ready for pickup', icon: 'takeout_dining' },
};

/** Incoming orders for the partner's restaurant, by stage, plus history. */
@Component({
  selector: 'bb-restaurant-orders',
  imports: [
    DatePipe,
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    MatPaginatorModule,
    EmptyState,
    OrderStatusChip,
    PageHeader,
    VegBadge,
    InrPipe,
  ],
  templateUrl: './restaurant-orders.html',
  styleUrl: './restaurant-orders.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RestaurantOrders {
  protected readonly board = inject(RestaurantOrderBoard);
  private readonly api = inject(RestaurantOrdersService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);

  protected readonly tabs = TABS;
  protected readonly next = NEXT;
  protected readonly tab = signal<Tab>('new');
  /** Order ids with a status change in flight (their buttons are disabled). */
  protected readonly busy = signal<ReadonlySet<string>>(new Set());
  /** Ticks every 30 s so "5 min ago" and the auto-reject countdown stay current. */
  protected readonly now = signal(Date.now());

  protected readonly history = signal<RestaurantOrderHistory | null>(null);
  protected readonly historyLoading = signal(false);
  protected readonly historyError = signal<string | null>(null);

  protected readonly countFor = (tab: (typeof TABS)[number]) =>
    tab.statuses.reduce((sum, s) => sum + (this.board.board()?.counts[s] ?? 0), 0);

  protected readonly shown = computed(() => {
    const statuses = TABS.find((t) => t.id === this.tab())?.statuses ?? [];
    return (this.board.board()?.items ?? []).filter((o) => statuses.includes(o.status));
  });

  constructor() {
    this.board.connect(inject(DestroyRef));
    interval(30_000)
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.now.set(Date.now()));
  }

  protected selectTab(tab: Tab): void {
    this.tab.set(tab);
    if (tab === 'history' && !this.history()) this.loadHistory(1);
  }

  protected minutesAgo(order: RestaurantOrder): number {
    return Math.max(0, Math.floor((this.now() - new Date(order.createdAt).getTime()) / 60_000));
  }

  /** Minutes left before an unanswered order auto-rejects. */
  protected minutesLeft(order: RestaurantOrder): number {
    return Math.max(0, RESPONSE_MINUTES - this.minutesAgo(order));
  }

  protected itemCount(order: RestaurantOrder): number {
    return order.items.reduce((sum, i) => sum + i.quantity, 0);
  }

  protected advance(order: RestaurantOrder): void {
    const step = NEXT[order.status];
    if (step) this.setStatus(order, step.action);
  }

  protected reject(order: RestaurantOrder): void {
    this.dialog
      .open<ConfirmDialog, ConfirmDialogData, true | string>(ConfirmDialog, {
        data: {
          title: `Reject order ${order.orderNumber}?`,
          message: 'The customer is told right away, with your reason.',
          reasonLabel: 'Reason (shown to the customer)',
          confirmLabel: 'Reject order',
          danger: true,
        },
        width: '460px',
      })
      .afterClosed()
      .pipe(filter((reason): reason is string => typeof reason === 'string'))
      .subscribe((reason) => this.setStatus(order, 'rejected', reason));
  }

  private setStatus(order: RestaurantOrder, status: RestaurantAction, reason?: string): void {
    this.busy.update((s) => new Set(s).add(order.id));
    const done = () =>
      this.busy.update((s) => {
        const copy = new Set(s);
        copy.delete(order.id);
        return copy;
      });
    this.api.setStatus(order.id, status, reason).subscribe({
      next: (updated) => {
        done();
        this.board.replace(updated);
        this.board.refresh();
        this.notify.success(MESSAGE[status]);
      },
      error: (err: unknown) => {
        done();
        this.notify.error(errorMessage(err));
        this.board.refresh(); // show what actually happened (e.g. the customer cancelled)
      },
    });
  }

  protected loadHistory(page: number): void {
    this.historyLoading.set(true);
    this.historyError.set(null);
    this.api.history(page, this.history()?.pagination.limit ?? 15).subscribe({
      next: (data) => {
        this.history.set(data);
        this.historyLoading.set(false);
      },
      error: (err: unknown) => {
        this.historyError.set(errorMessage(err, 'Could not load order history.'));
        this.historyLoading.set(false);
      },
    });
  }

  protected onHistoryPage(event: PageEvent): void {
    this.history.update((h) => (h ? { ...h, pagination: { ...h.pagination, limit: event.pageSize } } : h));
    this.loadHistory(event.pageIndex + 1);
  }
}

const MESSAGE: Record<RestaurantAction, string> = {
  confirmed: 'Order accepted',
  rejected: 'Order rejected',
  preparing: 'Marked as preparing',
  ready_for_pickup: 'Ready for pickup. Finding a rider…',
};
