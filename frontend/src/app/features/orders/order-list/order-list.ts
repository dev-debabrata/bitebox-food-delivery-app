import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RealtimeService } from '../../../core/services/realtime.service';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { errorMessage } from '../../../core/services/api-error';
import { OrderService } from '../../../core/services/checkout-api.service';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { Pagination } from '../../../shared/models/api.models';
import { ORDER_STATUS_LABEL, Order } from '../../../shared/models/checkout.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';

@Component({
  selector: 'bb-order-list',
  imports: [DatePipe, RouterLink, MatButtonModule, MatIconModule, EmptyState, PageHeader, InrPipe],
  templateUrl: './order-list.html',
  styleUrl: './order-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrderList {
  private readonly service = inject(OrderService);
  protected readonly statusLabel = ORDER_STATUS_LABEL;
  protected readonly orders = signal<Order[]>([]);
  protected readonly pagination = signal<Pagination | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly canLoadMore = computed(() => {
    const p = this.pagination();
    return !!p && p.page < p.totalPages;
  });

  constructor() {
    this.load(1);
    // Live status changes for orders already on screen.
    inject(RealtimeService)
      .orderUpdates$.pipe(takeUntilDestroyed())
      .subscribe((e) => this.orders.update((list) => list.map((o) => (o.id === e.id ? { ...o, status: e.status } : o))));
  }

  protected load(page: number): void {
    this.loading.set(true);
    this.error.set(null);
    this.service.mine(page).subscribe({
      next: (res) => {
        this.orders.update((list) => (page === 1 ? res.items : [...list, ...res.items]));
        this.pagination.set(res.pagination);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(errorMessage(err, 'Could not load your orders.'));
        this.loading.set(false);
      },
    });
  }

  protected summary(order: Order): string {
    return order.items.map((i) => `${i.name} × ${i.quantity}`).join(', ');
  }
}
