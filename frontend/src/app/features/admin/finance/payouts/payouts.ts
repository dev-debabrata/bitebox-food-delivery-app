import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatPaginatorModule } from '@angular/material/paginator';
import { IconComponent, SelectOption } from 'nexprime';
import { Observable } from 'rxjs';
import { FinanceService } from '../../../../core/services/admin/finance.service';
import { errorMessage, resourceError } from '../../../../core/services/api-error';
import { NotificationService } from '../../../../core/services/notification.service';
import { confirmed } from '../../../../shared/components/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { pagedList } from '../../../../shared/list/paged-list';
import {
  PAYOUT_STATUS_LABEL,
  PAYOUT_STATUS_TONE,
  Payout,
  PayoutDue,
  PayoutStatus,
  PayoutType,
} from '../../../../shared/models/admin-roles.models';
import { InrPipe, formatPaise } from '../../../../shared/pipes/money.pipes';

const COPY: Record<PayoutType, { title: string; subtitle: string; payee: string }> = {
  restaurant: {
    title: 'Restaurant payouts',
    subtitle: 'Each restaurant earns its share of delivered orders (food value minus commission).',
    payee: 'Restaurant',
  },
  rider: {
    title: 'Delivery partner payments',
    subtitle: 'Each rider earns a base amount plus a per-km rate for every delivery.',
    payee: 'Delivery partner',
  },
};

@Component({
  selector: 'bb-payouts',
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
  templateUrl: './payouts.html',
  styleUrl: './payouts.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PayoutsPage {
  private readonly api = inject(FinanceService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);

  /** Route parameter: restaurant or rider. */
  readonly type = input<PayoutType>('restaurant');
  protected readonly copy = computed(() => COPY[this.type()] ?? COPY.restaurant);
  protected readonly statusLabel = PAYOUT_STATUS_LABEL;
  protected readonly statusTone = PAYOUT_STATUS_TONE;
  protected readonly busy = signal<string | null>(null);

  protected readonly due = rxResource({
    params: () => this.type(),
    stream: ({ params }) => this.api.due(params),
  });
  protected readonly dueError = resourceError(this.due, 'Could not load what is owed.');
  protected readonly dueTotal = computed(() =>
    (this.due.hasValue() ? this.due.value() : []).reduce((n, r) => n + r.amountPaise, 0),
  );

  protected readonly filterModel = signal({ status: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly statusOptions: SelectOption[] = [
    { value: '', label: 'Any status' },
    ...(Object.keys(PAYOUT_STATUS_LABEL) as PayoutStatus[]).map((s) => ({
      value: s,
      label: PAYOUT_STATUS_LABEL[s],
    })),
  ];
  protected readonly history = pagedList(
    (page, limit) =>
      this.api.payouts({
        type: this.type(),
        status: (this.filterModel().status || undefined) as PayoutStatus | undefined,
        page,
        limit,
      }),
    {
      filterKey: () => `${this.type()}|${this.filterModel().status}`,
      errorText: 'Could not load payouts.',
    },
  );

  protected payOut(row: PayoutDue): void {
    confirmed(this.dialog, {
      title: `Pay ${row.name} ${formatPaise(row.amountPaise)}?`,
      message: `Creates a payout for ${row.orders} delivered order${row.orders === 1 ? '' : 's'}. Send the money, then mark the payout as paid with the transfer reference.`,
      confirmLabel: 'Create payout',
    }).subscribe(() =>
      this.run(row.payeeId, this.api.createPayout(this.type(), row.payeeId), 'Payout created'),
    );
  }

  protected markPaid(p: Payout): void {
    confirmed(this.dialog, {
      title: `Mark ${formatPaise(p.amountPaise)} to ${p.payeeName} as paid?`,
      message: 'Enter the bank or UPI transfer reference so the payment can be traced.',
      confirmLabel: 'Mark as paid',
      reasonLabel: 'Transfer reference',
      reasonMax: 120,
    }).subscribe((reference) =>
      this.run(p.id, this.api.markPaid(p.id, String(reference)), 'Payout marked as paid'),
    );
  }

  protected cancel(p: Payout): void {
    confirmed(this.dialog, {
      title: `Cancel this payout to ${p.payeeName}?`,
      message: 'Its orders go back to "owed" so they can be paid out again.',
      confirmLabel: 'Cancel payout',
      danger: true,
      reasonLabel: 'Why',
    }).subscribe((note) =>
      this.run(p.id, this.api.cancelPayout(p.id, String(note)), 'Payout cancelled'),
    );
  }

  private run(id: string, action: Observable<Payout>, done: string): void {
    this.busy.set(id);
    action.subscribe({
      next: () => {
        this.busy.set(null);
        this.notify.success(done);
        this.due.reload();
        this.history.reload();
      },
      error: (err: unknown) => {
        this.busy.set(null);
        this.notify.error(errorMessage(err));
        this.due.reload();
      },
    });
  }
}
