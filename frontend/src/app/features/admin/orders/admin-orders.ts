import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { SelectOption } from 'nexprime';
import { catchError, debounceTime, distinctUntilChanged, filter, map, of, skip } from 'rxjs';
import { errorMessage } from '../../../core/services/api-error';
import { AdminOrdersService } from '../../../core/services/order-management.service';
import { pollWhileVisible } from '../../../core/services/poll';
import { RealtimeService } from '../../../core/services/realtime.service';
import { OrderStatusChip } from '../../../shared/components/order-status-chip/order-status-chip';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { ORDER_STATUS_LABEL, Order, OrderStatus } from '../../../shared/models/checkout.models';
import { AdminOrderList } from '../../../shared/models/order-management.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';
import { AdminOrderDialog } from './admin-order-dialog';

/** Fallback refresh; live order events reload the list within a second. */
const POLL_MS = 60_000;

/** Every order on the platform: filter, search by number, open one to act on it. */
@Component({
  selector: 'bb-admin-orders',
  imports: [DatePipe, NP_FORM_FIELDS, MatButtonModule, MatIconModule, MatPaginatorModule, OrderStatusChip, PageHeader, InrPipe],
  templateUrl: './admin-orders.html',
  styleUrl: './admin-orders.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminOrders {
  private readonly api = inject(AdminOrdersService);
  private readonly dialog = inject(MatDialog);

  protected readonly filterModel = signal({ status: 'active', search: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly statusOptions = computed<SelectOption[]>(() => {
    const counts = this.data()?.counts ?? {};
    const active = (['pending', 'confirmed', 'preparing', 'ready_for_pickup', 'assigned', 'picked_up', 'on_the_way'] as OrderStatus[]).reduce(
      (sum, s) => sum + (counts[s] ?? 0),
      0,
    );
    return [
      { value: 'active', label: `In progress (${active})` },
      { value: '', label: 'All orders' },
      ...(Object.keys(ORDER_STATUS_LABEL) as OrderStatus[]).map((s) => ({ value: s, label: `${ORDER_STATUS_LABEL[s]} (${counts[s] ?? 0})` })),
    ];
  });

  protected readonly data = signal<AdminOrderList | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  private page = 1;
  private limit = 20;

  constructor() {
    pollWhileVisible(() => this.request(), POLL_MS)
      .pipe(takeUntilDestroyed())
      .subscribe((d) => d && this.data.set(d));
    inject(RealtimeService)
      .orderUpdates$.pipe(debounceTime(1000), takeUntilDestroyed())
      .subscribe(() => this.load(this.page));

    // New filters start again from page 1 (search is debounced while typing).
    toObservable(computed(() => `${this.filterModel().status}|${this.filterModel().search.trim()}`))
      .pipe(skip(1), debounceTime(300), distinctUntilChanged(), takeUntilDestroyed())
      .subscribe(() => this.load(1));
  }

  private request() {
    const { status, search } = this.filterModel();
    this.loading.set(true);
    return this.api
      .list({ status: (status || undefined) as OrderStatus | 'active' | undefined, search: search.trim() || undefined, page: this.page, limit: this.limit })
      .pipe(
        map((d) => {
          this.loading.set(false);
          this.error.set(null);
          return d;
        }),
        catchError((err: unknown) => {
          this.loading.set(false);
          this.error.set(errorMessage(err, 'Could not load orders.'));
          return of(null);
        }),
      );
  }

  protected load(page: number): void {
    this.page = page;
    this.request().subscribe((d) => d && this.data.set(d));
  }

  protected onPage(event: PageEvent): void {
    this.limit = event.pageSize;
    this.load(event.pageIndex + 1);
  }

  protected itemCount(order: Order): number {
    return order.items.reduce((sum, i) => sum + i.quantity, 0);
  }

  protected open(order: Order): void {
    this.dialog
      .open<AdminOrderDialog, string, boolean>(AdminOrderDialog, { data: order.id, width: '720px', maxWidth: '95vw', autoFocus: 'dialog' })
      .afterClosed()
      .pipe(filter(Boolean))
      .subscribe(() => this.load(this.page));
  }
}
