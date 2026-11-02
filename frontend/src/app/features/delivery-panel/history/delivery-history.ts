import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { errorMessage } from '../../../core/services/api-error';
import { RiderService } from '../../../core/services/order-management.service';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { OrderStatusChip } from '../../../shared/components/order-status-chip/order-status-chip';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { Paginated } from '../../../shared/models/api.models';
import { RiderOrder } from '../../../shared/models/order-management.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';

/** The rider's finished deliveries, newest first. */
@Component({
  selector: 'bb-delivery-history',
  imports: [DatePipe, MatButtonModule, MatIconModule, MatPaginatorModule, EmptyState, OrderStatusChip, PageHeader, InrPipe],
  templateUrl: './delivery-history.html',
  styleUrl: './delivery-history.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeliveryHistory {
  private readonly rider = inject(RiderService);

  protected readonly page = signal<Paginated<RiderOrder> | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  private limit = 15;

  constructor() {
    this.load(1);
  }

  protected load(page: number): void {
    this.loading.set(true);
    this.error.set(null);
    this.rider.history(page, this.limit).subscribe({
      next: (data) => {
        this.page.set(data);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(errorMessage(err, 'Could not load your deliveries.'));
        this.loading.set(false);
      },
    });
  }

  protected onPage(event: PageEvent): void {
    this.limit = event.pageSize;
    this.load(event.pageIndex + 1);
  }
}
