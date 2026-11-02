import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { ToggleComponent } from 'nexprime';
import { catchError, debounceTime, distinctUntilChanged, filter, map, of, skip } from 'rxjs';
import { errorMessage } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { AdminOrdersService } from '../../../core/services/order-management.service';
import { pollWhileVisible } from '../../../core/services/poll';
import { RealtimeService } from '../../../core/services/realtime.service';
import { ConfirmDialog, ConfirmDialogData } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { OrderStatusChip } from '../../../shared/components/order-status-chip/order-status-chip';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { Paginated } from '../../../shared/models/api.models';
import { VEHICLE_LABEL } from '../../../shared/models/checkout.models';
import { AdminRider } from '../../../shared/models/order-management.models';
import { AdminOrderDialog } from '../orders/admin-order-dialog';

/** Fallback refresh; live order events reload the list within a second. */
const POLL_MS = 60_000;

/** Riders: who is online, what they are carrying, suspend/reactivate. */
@Component({
  selector: 'bb-admin-delivery-partners',
  imports: [DatePipe, NP_FORM_FIELDS, MatButtonModule, MatIconModule, MatPaginatorModule, ToggleComponent, OrderStatusChip, PageHeader],
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
  protected readonly data = signal<Paginated<AdminRider> | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly busyId = signal<string | null>(null);
  protected readonly vehicleLabel = VEHICLE_LABEL;
  private page = 1;
  private limit = 20;

  constructor() {
    pollWhileVisible(() => this.request(), POLL_MS)
      .pipe(takeUntilDestroyed())
      .subscribe((d) => d && this.data.set(d));
    inject(RealtimeService)
      .orderUpdates$.pipe(debounceTime(1000), takeUntilDestroyed())
      .subscribe(() => this.load(this.page));
    toObservable(computed(() => `${this.filterModel().onlineOnly}|${this.filterModel().search.trim()}`))
      .pipe(skip(1), debounceTime(300), distinctUntilChanged(), takeUntilDestroyed())
      .subscribe(() => this.load(1));
  }

  private request() {
    const { search, onlineOnly } = this.filterModel();
    this.loading.set(true);
    return this.api.riders({ search: search.trim() || undefined, online: onlineOnly || undefined, page: this.page, limit: this.limit }).pipe(
      map((d) => {
        this.loading.set(false);
        this.error.set(null);
        return d;
      }),
      catchError((err: unknown) => {
        this.loading.set(false);
        this.error.set(errorMessage(err, 'Could not load delivery partners.'));
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

  protected openOrder(id: string): void {
    this.dialog
      .open<AdminOrderDialog, string, boolean>(AdminOrderDialog, { data: id, width: '720px', maxWidth: '95vw', autoFocus: 'dialog' })
      .afterClosed()
      .pipe(filter(Boolean))
      .subscribe(() => this.load(this.page));
  }

  protected toggleStatus(rider: AdminRider): void {
    const suspend = rider.status === 'active';
    this.dialog
      .open<ConfirmDialog, ConfirmDialogData, true>(ConfirmDialog, {
        data: suspend
          ? { title: `Suspend ${rider.name}?`, message: 'They are taken offline and signed out, and cannot accept deliveries.', confirmLabel: 'Suspend', danger: true }
          : { title: `Reactivate ${rider.name}?`, message: 'They can sign in and go online again.', confirmLabel: 'Reactivate' },
        width: '420px',
      })
      .afterClosed()
      .pipe(filter(Boolean))
      .subscribe(() => {
        this.busyId.set(rider.id);
        this.api.setRiderStatus(rider.id, suspend ? 'suspended' : 'active').subscribe({
          next: () => {
            this.busyId.set(null);
            this.notify.success(suspend ? 'Rider suspended' : 'Rider reactivated');
            this.load(this.page);
          },
          error: (err: unknown) => {
            this.busyId.set(null);
            this.notify.error(errorMessage(err));
          },
        });
      });
  }
}
