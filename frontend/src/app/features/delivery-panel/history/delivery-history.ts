import { IconComponent, PaginationComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RiderService } from '../../../core/services/order-management.service';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { OrderStatusChip } from '../../../shared/components/order-status-chip/order-status-chip';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { pagedList } from '../../../shared/list/paged-list';
import { InrPipe } from '../../../shared/pipes/money.pipes';

@Component({
  selector: 'bb-delivery-history',
  imports: [
    DatePipe,
    IconComponent,
    PaginationComponent,
    EmptyState,
    OrderStatusChip,
    PageHeader,
    InrPipe,
  ],
  templateUrl: './delivery-history.html',
  styleUrl: './delivery-history.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeliveryHistory {
  private readonly rider = inject(RiderService);
  protected readonly list = pagedList((page, limit) => this.rider.history(page, limit), {
    limit: 15,
    errorText: 'Could not load your deliveries.',
  });
}
