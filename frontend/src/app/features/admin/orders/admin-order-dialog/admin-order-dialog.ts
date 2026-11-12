import { ButtonComponent, IconComponent } from 'nexprime';
import { pickRider } from './assign-rider-dialog/assign-rider-dialog';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { Observable, filter } from 'rxjs';
import { AuthService } from '../../../../core/auth/auth.service';
import { errorMessage } from '../../../../core/services/api-error';
import { NotificationService } from '../../../../core/services/notification.service';
import { AdminOrdersService } from '../../../../core/services/order-management.service';
import { BillSummary } from '../../../../shared/components/bill-summary/bill-summary';
import {
  ConfirmDialogData,
  confirmed,
} from '../../../../shared/components/confirm-dialog/confirm-dialog';
import { OrderStatusChip } from '../../../../shared/components/order-status-chip/order-status-chip';
import { deliveryTracking } from '../../../../shared/components/tracking-map/delivery-tracking';
import { TrackingMap } from '../../../../shared/components/tracking-map/tracking-map';
import { VegBadge } from '../../../../shared/components/veg-badge/veg-badge';
import {
  ORDER_STATUS_LABEL,
  OrderStatus,
  VEHICLE_LABEL,
  customerStatusLabel,
} from '../../../../shared/models/checkout.models';
import { AdminOrder, TRACKED_STATUSES } from '../../../../shared/models/order-management.models';
import { InrPipe } from '../../../../shared/pipes/money.pipes';
import { PAYMENT_STATUS_LABEL, PROVIDER_LABEL } from '../../../../shared/models/payment.models';
import {
  BB_DIALOG_DATA,
  BbDialog,
  BbDialogRef,
  BbDialogTitle,
} from '../../../../shared/dialog/bb-dialog';

const CANCELLABLE: OrderStatus[] = [
  'pending',
  'confirmed',
  'preparing',
  'ready_for_pickup',
  'assigned',
  'arrived_at_restaurant',
];

@Component({
  selector: 'bb-admin-order-dialog',
  imports: [
    DatePipe,
    DecimalPipe,
    BbDialogTitle,
    ButtonComponent,
    IconComponent,
    BillSummary,
    OrderStatusChip,
    TrackingMap,
    VegBadge,
    InrPipe,
  ],
  templateUrl: './admin-order-dialog.html',
  styleUrl: './admin-order-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminOrderDialog {
  private readonly id = inject<string>(BB_DIALOG_DATA);
  protected readonly ref = inject<BbDialogRef<boolean>>(BbDialogRef);
  private readonly api = inject(AdminOrdersService);
  private readonly dialog = inject(BbDialog);
  private readonly notify = inject(NotificationService);
  /** Support can read orders; only operations (and the super admin) cancel or unassign. */
  protected readonly canManage = inject(AuthService).can('orders:manage');

  protected readonly order = signal<AdminOrder | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly changed = signal(false);
  protected readonly statusLabel = ORDER_STATUS_LABEL;
  protected readonly vehicleLabel = VEHICLE_LABEL;
  protected readonly paymentLabel = PAYMENT_STATUS_LABEL;
  protected readonly customerLabel = customerStatusLabel;
  protected readonly providerLabel = PROVIDER_LABEL;
  protected readonly tracking = deliveryTracking(this.order);
  protected readonly onTheRoad = (o: AdminOrder) => TRACKED_STATUSES.includes(o.status);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.error.set(null);
    this.api.get(this.id).subscribe({
      next: (o) => this.order.set(o),
      error: (err: unknown) => this.error.set(errorMessage(err, 'Could not load this order.')),
    });
  }

  protected canCancel(o: AdminOrder): boolean {
    return CANCELLABLE.includes(o.status);
  }

  protected cancel(o: AdminOrder): void {
    this.confirm(
      {
        title: `Cancel order ${o.orderNumber}?`,
        message:
          'The customer, restaurant and rider (if any) will see it as cancelled. This cannot be undone.',
        reasonLabel: 'Reason (shown to the customer)',
        confirmLabel: 'Cancel order',
        danger: true,
      },
      (reason) => this.api.cancel(o.id, reason!),
      'Order cancelled',
    );
  }

  protected unassign(o: AdminOrder): void {
    this.confirm(
      {
        title: 'Unassign the rider?',
        message: `${o.rider?.name ?? 'The rider'} is released and the order is offered to another nearby rider.`,
        reasonLabel: 'Reason (for the order history)',
        confirmLabel: 'Unassign',
      },
      (reason) => this.api.unassign(o.id, reason),
      'Rider unassigned. Finding another rider…',
    );
  }

  protected assign(o: AdminOrder): void {
    pickRider(this.dialog, o).subscribe((riderId) =>
      this.run(this.api.assign(o.id, riderId), 'Rider assigned'),
    );
  }

  protected resetCode(o: AdminOrder): void {
    this.confirm(
      {
        title: 'Send a new delivery code?',
        message: `The customer gets a new 4-digit code for ${o.orderNumber}, and the rider can try again${
          o.deliveryOtpAttempts ? ` (${o.deliveryOtpAttempts} wrong so far)` : ''
        }.`,
        confirmLabel: 'Send new code',
      },
      () => this.api.resetDeliveryCode(o.id),
      'New delivery code sent to the customer',
    );
  }

  private confirm(
    data: ConfirmDialogData,
    action: (reason?: string) => Observable<AdminOrder>,
    message: string,
  ): void {
    confirmed(this.dialog, data, '460px').subscribe((result) =>
      this.run(action(typeof result === 'string' ? result : undefined), message),
    );
  }

  /** Runs an order action: busy while it runs, then the updated order, or the error and a reload. */
  private run(request: Observable<AdminOrder>, message: string): void {
    this.busy.set(true);
    request.subscribe({
      next: (o) => {
        this.order.set(o);
        this.busy.set(false);
        this.changed.set(true);
        this.notify.success(message);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.notify.error(errorMessage(err));
        this.load();
      },
    });
  }
}

export function openAdminOrder(dialog: BbDialog, orderId: string): Observable<true> {
  return dialog
    .open<AdminOrderDialog, string, boolean>(AdminOrderDialog, { data: orderId, width: '820px' })
    .closed.pipe(filter((changed): changed is true => changed === true));
}
