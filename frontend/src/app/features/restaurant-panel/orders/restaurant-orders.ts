import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import { IconComponent } from 'nexprime';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDialog } from '@angular/material/dialog';
import { MatPaginatorModule } from '@angular/material/paginator';
import { interval } from 'rxjs';
import { errorMessage } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { RestaurantOrdersService } from '../../../core/services/order-management.service';
import { RestaurantOrderBoard } from '../../../core/services/restaurant-order-board';
import { confirmed } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { OrderStatusChip } from '../../../shared/components/order-status-chip/order-status-chip';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { pagedList } from '../../../shared/list/paged-list';
import { VegBadge } from '../../../shared/components/veg-badge/veg-badge';
import { OrderStatus } from '../../../shared/models/checkout.models';
import { RestaurantAction, RestaurantOrder } from '../../../shared/models/order-management.models';
import { ItemCountPipe } from '../../../shared/pipes/item-count.pipe';
import { InrPipe } from '../../../shared/pipes/money.pipes';

type Tab = 'new' | 'preparing' | 'ready' | 'out' | 'history';

const TABS: { id: Tab; label: string; statuses: OrderStatus[] }[] = [
  { id: 'new', label: 'New', statuses: ['pending'] },
  { id: 'preparing', label: 'Preparing', statuses: ['confirmed', 'preparing'] },
  { id: 'ready', label: 'Ready for pickup', statuses: ['ready_for_pickup', 'assigned'] },
  { id: 'out', label: 'Out for delivery', statuses: ['picked_up', 'on_the_way'] },
  { id: 'history', label: 'History', statuses: [] },
];

const NEXT: Partial<
  Record<OrderStatus, { action: RestaurantAction; label: string; icon: string }>
> = {
  pending: { action: 'confirmed', label: 'Accept', icon: 'check' },
  confirmed: { action: 'preparing', label: 'Start preparing', icon: 'skillet' },
  preparing: { action: 'ready_for_pickup', label: 'Ready for pickup', icon: 'takeout_dining' },
};

@Component({
  selector: 'bb-restaurant-orders',
  imports: [
    DatePipe,
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    IconComponent,
    NpIconPipe,
    MatPaginatorModule,
    EmptyState,
    OrderStatusChip,
    PageHeader,
    VegBadge,
    InrPipe,
    ItemCountPipe,
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
  protected readonly busy = signal<ReadonlySet<string>>(new Set());
  protected readonly now = signal(Date.now());

  protected readonly history = pagedList((page, limit) => this.api.history(page, limit), {
    limit: 15,
    lazy: true,
    errorText: 'Could not load order history.',
  });

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
    if (tab === 'history' && !this.history.data()) this.history.load(1);
  }

  protected minutesAgo(order: RestaurantOrder): number {
    return Math.max(0, Math.floor((this.now() - new Date(order.createdAt).getTime()) / 60_000));
  }

  protected minutesLeft(order: RestaurantOrder): number {
    return order.respondBy
      ? Math.max(0, Math.ceil((new Date(order.respondBy).getTime() - this.now()) / 60_000))
      : 0;
  }

  protected advance(order: RestaurantOrder): void {
    const step = NEXT[order.status];
    if (step) this.setStatus(order, step.action);
  }

  protected reject(order: RestaurantOrder): void {
    confirmed(
      this.dialog,
      {
        title: `Reject order ${order.orderNumber}?`,
        message: 'The customer is told right away, with your reason.',
        reasonLabel: 'Reason (shown to the customer)',
        confirmLabel: 'Reject order',
        danger: true,
      },
      '460px',
    ).subscribe((reason) => this.setStatus(order, 'rejected', reason as string));
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
        this.board.applyChange(updated);
        this.notify.success(MESSAGE[status]);
      },
      error: (err: unknown) => {
        done();
        this.notify.error(errorMessage(err));
        this.board.refresh(); // show what actually happened (e.g. the customer cancelled)
      },
    });
  }
}

const MESSAGE: Record<RestaurantAction, string> = {
  confirmed: 'Order accepted',
  rejected: 'Order rejected',
  preparing: 'Marked as preparing',
  ready_for_pickup: 'Ready for pickup. Finding a rider…',
};
