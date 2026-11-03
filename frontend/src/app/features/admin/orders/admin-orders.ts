import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatPaginatorModule } from '@angular/material/paginator';
import { IconComponent, SelectOption } from 'nexprime';
import { AdminOrdersService } from '../../../core/services/order-management.service';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { OrderStatusChip } from '../../../shared/components/order-status-chip/order-status-chip';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { pagedList } from '../../../shared/list/paged-list';
import { ORDER_STATUS_LABEL, OrderStatus, customerStatusLabel } from '../../../shared/models/checkout.models';
import { ACTIVE_STATUSES } from '../../../shared/models/order-management.models';
import { ItemCountPipe } from '../../../shared/pipes/item-count.pipe';
import { InrPipe } from '../../../shared/pipes/money.pipes';
import { openAdminOrder } from './admin-order-dialog';

/** Every order on the platform: filter, search by number, open one to act on it. */
@Component({
  selector: 'bb-admin-orders',
  imports: [
    DatePipe,
    NP_FORM_FIELDS,
    MatButtonModule,
    IconComponent,
    MatPaginatorModule,
    EmptyState,
    OrderStatusChip,
    PageHeader,
    InrPipe,
    ItemCountPipe,
  ],
  templateUrl: './admin-orders.html',
  styleUrl: './admin-orders.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminOrders {
  private readonly api = inject(AdminOrdersService);
  private readonly dialog = inject(MatDialog);
  /** "Awaiting payment" for unpaid online orders. */
  protected readonly statusLabel = customerStatusLabel;

  protected readonly filterModel = signal({ status: 'active', search: '' });
  protected readonly filters = form(this.filterModel);

  /** Live list: any order change reloads the current page; slow poll as a fallback. */
  protected readonly list = pagedList(
    (page, limit) => {
      const { status, search } = this.filterModel();
      return this.api.list({
        status: (status || undefined) as OrderStatus | 'active' | undefined,
        search: search.trim() || undefined,
        page,
        limit,
      });
    },
    {
      filterKey: () => `${this.filterModel().status}|${this.filterModel().search.trim()}`,
      pollMs: 60_000,
      errorText: 'Could not load orders.',
    },
  );

  protected readonly statusOptions = computed<SelectOption[]>(() => {
    const counts = this.list.data()?.counts ?? {};
    const active = ACTIVE_STATUSES.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
    return [
      { value: 'active', label: `In progress (${active})` },
      { value: '', label: 'All orders' },
      ...(Object.keys(ORDER_STATUS_LABEL) as OrderStatus[]).map((s) => ({
        value: s,
        label: `${ORDER_STATUS_LABEL[s]} (${counts[s] ?? 0})`,
      })),
    ];
  });

  protected open(id: string): void {
    openAdminOrder(this.dialog, id).subscribe(() => this.list.reload());
  }
}
