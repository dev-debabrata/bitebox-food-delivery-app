import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatPaginatorModule } from '@angular/material/paginator';
import { IconComponent, SelectOption } from 'nexprime';
import { errorMessage } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { ReportsService } from '../../../core/services/reports.service';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { pagedList } from '../../../shared/list/paged-list';
import { PaymentStatus } from '../../../shared/models/checkout.models';
import {
  AdminPayment,
  PAYMENT_STATUS_LABEL,
  PROVIDER_LABEL,
  PaymentMethod,
} from '../../../shared/models/payment.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';
import { AuthService } from '../../../core/auth/auth.service';
import { openTransaction } from '../finance/transaction-dialog/transaction-dialog';

@Component({
  selector: 'bb-admin-payments',
  imports: [
    DatePipe,
    NP_FORM_FIELDS,
    MatButtonModule,
    IconComponent,
    MatPaginatorModule,
    EmptyState,
    PageHeader,
    InrPipe,
  ],
  templateUrl: './admin-payments.html',
  styleUrl: './admin-payments.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminPayments {
  private readonly api = inject(ReportsService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);

  protected readonly statusLabel = PAYMENT_STATUS_LABEL;
  protected readonly providerLabel = PROVIDER_LABEL;
  protected readonly canRefund = inject(AuthService).can('refunds:manage');
  protected readonly filterModel = signal({ status: '', method: '', search: '' });
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
  protected readonly refunding = signal<string | null>(null);

  protected readonly list = pagedList(
    (page, limit) => {
      const { status, method, search } = this.filterModel();
      return this.api.payments({
        status: (status || undefined) as PaymentStatus | undefined,
        method: (method || undefined) as PaymentMethod | undefined,
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
