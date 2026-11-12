import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatPaginatorModule } from '@angular/material/paginator';
import { IconComponent, ToggleComponent } from 'nexprime';
import { errorMessage } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { AdminOrdersService } from '../../../core/services/order-management.service';
import { confirmed } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { OrderStatusChip } from '../../../shared/components/order-status-chip/order-status-chip';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { pagedList } from '../../../shared/list/paged-list';
import { OrderStatus, VEHICLE_LABEL } from '../../../shared/models/checkout.models';
import { AdminRider } from '../../../shared/models/order-management.models';
import { openAdminOrder } from '../orders/admin-order-dialog/admin-order-dialog';

const RIDER_EVENTS: OrderStatus[] = [
  'ready_for_pickup',
  'assigned',
  'picked_up',
  'on_the_way',
  'delivered',
  'cancelled',
];

@Component({
  selector: 'bb-admin-delivery-partners',
  imports: [
    DatePipe,
    NP_FORM_FIELDS,
    MatButtonModule,
    IconComponent,
    MatPaginatorModule,
    ToggleComponent,
    EmptyState,
    OrderStatusChip,
    PageHeader,
  ],
  templateUrl: './admin-delivery-partners.html',
  styleUrl: './admin-delivery-partners.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminDeliveryPartners {
  private readonly api = inject(AdminOrdersService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);

  protected readonly filterModel = signal({ search: '', onlineOnly: false });
  protected readonly filters = form(this.filterModel);
  protected readonly busyId = signal<string | null>(null);
  protected readonly vehicleLabel = VEHICLE_LABEL;

  protected readonly list = pagedList(
    (page, limit) => {
      const { search, onlineOnly } = this.filterModel();
      return this.api.riders({
        search: search.trim() || undefined,
        online: onlineOnly || undefined,
        page,
        limit,
      });
    },
    {
      filterKey: () => `${this.filterModel().onlineOnly}|${this.filterModel().search.trim()}`,
      pollMs: 60_000,
      when: (e) => RIDER_EVENTS.includes(e.status),
      errorText: 'Could not load delivery partners.',
    },
  );

  protected openOrder(id: string): void {
    openAdminOrder(this.dialog, id).subscribe(() => this.list.reload());
  }

  protected toggleStatus(rider: AdminRider): void {
    const suspend = rider.status === 'active';
    confirmed(
      this.dialog,
      suspend
        ? {
            title: `Suspend ${rider.name}?`,
            message: 'They are taken offline and signed out, and cannot accept deliveries.',
            confirmLabel: 'Suspend',
            danger: true,
          }
        : {
            title: `Reactivate ${rider.name}?`,
            message: 'They can sign in and go online again.',
            confirmLabel: 'Reactivate',
          },
      '420px',
    ).subscribe(() => {
      this.busyId.set(rider.id);
      this.api.setRiderStatus(rider.id, suspend ? 'suspended' : 'active').subscribe({
        next: () => {
          this.busyId.set(null);
          this.notify.success(suspend ? 'Rider suspended' : 'Rider reactivated');
          this.list.reload();
        },
        error: (err: unknown) => {
          this.busyId.set(null);
          this.notify.error(errorMessage(err));
        },
      });
    });
  }
}
