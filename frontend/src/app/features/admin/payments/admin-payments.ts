import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { form } from '@angular/forms/signals';
import { ButtonComponent, IconComponent, PaginationComponent, SelectOption } from 'nexprime';
import { errorMessage } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { ReportsService } from '../../../core/services/reports.service';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { OrderStatusChip } from '../../../shared/components/order-status-chip/order-status-chip';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { pagedList } from '../../../shared/list/paged-list';
import { PaymentStatus } from '../../../shared/models/checkout.models';
import {
  AdminPayment,
  OrderState,
  PAYMENT_STATUS_LABEL,
  PROVIDER_LABEL,
  PaymentMethod,
} from '../../../shared/models/payment.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';
import { AuthService } from '../../../core/auth/auth.service';
import { BbDialog } from '../../../shared/dialog/bb-dialog';
import { openTransaction } from '../finance/transaction-dialog/transaction-dialog';
import { openRefund } from './refund-dialog/refund-dialog';

@Component({
  selector: 'bb-admin-payments',
  imports: [
    DatePipe,
    NP_FORM_FIELDS,
    ButtonComponent,
    IconComponent,
    PaginationComponent,
    EmptyState,
    OrderStatusChip,
    PageHeader,
    InrPipe,
  ],
  templateUrl: './admin-payments.html',
  styleUrl: './admin-payments.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminPayments {
  private readonly api = inject(ReportsService);
  private readonly dialog = inject(BbDialog);
  private readonly notify = inject(NotificationService);

  protected readonly statusLabel = PAYMENT_STATUS_LABEL;
  protected readonly providerLabel = PROVIDER_LABEL;
  protected readonly canRefund = inject(AuthService).can('refunds:manage');
  protected readonly filterModel = signal({ status: '', method: '', orderState: '', search: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly statusOptions: SelectOption[] = [
    { value: '', label: 'Any status' },
    ...(Object.keys(PAYMENT_STATUS_LABEL) as PaymentStatus[]).map((s) => ({
      value: s,
      label: PAYMENT_STATUS_LABEL[s],
    })),
  ];
  protected readonly methodOptions: SelectOption[] = [
    { value: '', label: 'Any method' },
    { value: 'cod', label: 'Cash on delivery' },
    { value: 'online', label: 'Online' },
  ];
  // Cancelled and rejected orders that were paid still hold money: finance refunds them from here.
  protected readonly orderStateOptions: SelectOption[] = [
    { value: '', label: 'Any order' },
    { value: 'active', label: 'Active orders' },
    { value: 'delivered', label: 'Delivered' },
    { value: 'cancelled', label: 'Cancelled or rejected' },
  ];
  protected readonly refunding = signal<string | null>(null);

  protected readonly list = pagedList(
    (page, limit) => {
      const { status, method, orderState, search } = this.filterModel();
      return this.api.payments({
        status: (status || undefined) as PaymentStatus | undefined,
        method: (method || undefined) as PaymentMethod | undefined,
        orderState: (orderState || undefined) as OrderState | undefined,
        search: search.trim() || undefined,
        page,
        limit,
      });
    },
    {
      filterKey: () => JSON.stringify(this.filterModel()),
      pollMs: 60_000,
      errorText: 'Could not load payments.',
    },
  );

  protected details(p: AdminPayment): void {
    openTransaction(this.dialog, p.id).subscribe();
  }

  /** Something to refund, or refunds to look at. */
  protected hasRefunds(p: AdminPayment): boolean {
    return (p.refundablePaise ?? 0) > 0 || (p.refundedPaise ?? 0) > 0;
  }

  protected refunds(p: AdminPayment): void {
    openRefund(this.dialog, p).subscribe(() => this.list.reload());
  }

  protected retryRefund(p: AdminPayment): void {
    this.refunding.set(p.id);
    this.api.retryRefund(p.id).subscribe({
      next: (payment) => {
        this.refunding.set(null);
        if (payment.status === 'refunded') this.notify.success('Refunded');
        else this.notify.error(payment.failureReason ?? 'The refund failed again.');
        this.list.reload();
      },
      error: (err: unknown) => {
        this.refunding.set(null);
        this.notify.error(errorMessage(err));
      },
    });
  }
}
