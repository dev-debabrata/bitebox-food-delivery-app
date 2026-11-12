import { TableLabels } from '../../../../shared/list/table-labels';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatPaginatorModule } from '@angular/material/paginator';
import { IconComponent, SelectOption } from 'nexprime';
import { AuthService } from '../../../../core/auth/auth.service';
import { FinanceService } from '../../../../core/services/admin/finance.service';
import { errorMessage } from '../../../../core/services/api-error';
import { NotificationService } from '../../../../core/services/notification.service';
import { ReportsService } from '../../../../core/services/reports.service';
import { EmptyState } from '../../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { pagedList } from '../../../../shared/list/paged-list';
import { RefundRow } from '../../../../shared/models/admin-roles.models';
import { InrPipe } from '../../../../shared/pipes/money.pipes';
import { openTransaction } from '../transaction-dialog/transaction-dialog';
import { BbDialog } from '../../../../shared/dialog/bb-dialog';

/**
 * Refund management. Refunds happen automatically when a paid online order is cancelled; this
 * page shows them, and the ones where the automatic refund failed so finance can retry.
 */
@Component({
  selector: 'bb-refunds',
  imports: [
    DatePipe,
    NP_FORM_FIELDS,
    MatButtonModule,
    MatPaginatorModule,
    IconComponent,
    EmptyState,
    PageHeader,
    InrPipe,
  ],
  templateUrl: './refunds.html',
  styleUrl: './refunds.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RefundsPage {
  private readonly api = inject(FinanceService);
  private readonly payments = inject(ReportsService);
  private readonly dialog = inject(BbDialog);
  private readonly notify = inject(NotificationService);
  protected readonly canRefund = inject(AuthService).can('refunds:manage');
  protected readonly busy = signal<string | null>(null);

  protected readonly filterModel = signal({ state: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly stateOptions: SelectOption[] = [
    { value: '', label: 'Needed and refunded' },
    { value: 'needed', label: 'Needs a refund' },
    { value: 'refunded', label: 'Refunded' },
  ];

  protected readonly list = pagedList(
    (page, limit) =>
      this.api.refunds({
        state: (this.filterModel().state || undefined) as 'needed' | 'refunded' | undefined,
        page,
        limit,
      }),
    {
      filterKey: () => this.filterModel().state,
      pollMs: 60_000,
      when: () => false,
      errorText: 'Could not load refunds.',
    },
  );

  protected details(r: RefundRow): void {
    openTransaction(this.dialog, r.id).subscribe();
  }

  protected retry(r: RefundRow): void {
    this.busy.set(r.id);
    this.payments.retryRefund(r.id).subscribe({
      next: (payment) => {
        this.busy.set(null);
        if (payment.status === 'refunded') this.notify.success('Refunded');
        else this.notify.error(payment.failureReason ?? 'The refund failed again.');
        this.list.reload();
      },
      error: (err: unknown) => {
        this.busy.set(null);
        this.notify.error(errorMessage(err));
      },
    });
  }
}
