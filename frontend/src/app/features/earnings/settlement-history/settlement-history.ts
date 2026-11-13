import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { ButtonComponent, ButtonToggleComponent, PaginationComponent } from 'nexprime';
import { NotificationService } from '../../../core/services/notification.service';
import { PartnerFinanceService } from '../../../core/services/partner-finance.service';
import { EarningsScope } from '../../../core/services/reports.service';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { pagedList } from '../../../shared/list/paged-list';
import { PAYOUT_STATUS_TONE, Payout } from '../../../shared/models/admin-roles.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';

type View = 'settlements' | 'payouts';
// Partner wording; the tones match the admin payouts screen.
const PAYOUT_LABEL: Record<Payout['status'], string> = {
  pending: 'Being paid',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

/**
 * A partner's settlement history (what each delivered order paid them, and whether it has been
 * paid out) and their payouts, with a PDF statement for each payout.
 */
@Component({
  selector: 'bb-settlement-history',
  imports: [
    DatePipe,
    ButtonComponent,
    ButtonToggleComponent,
    PaginationComponent,
    EmptyState,
    InrPipe,
  ],
  templateUrl: './settlement-history.html',
  styleUrl: './settlement-history.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettlementHistory implements OnInit {
  private readonly api = inject(PartnerFinanceService);
  private readonly notify = inject(NotificationService);
  readonly scope = input<EarningsScope>('restaurant');

  protected readonly view = signal<View>('settlements');
  protected readonly views = [
    { value: 'settlements' as const, label: 'By order' },
    { value: 'payouts' as const, label: 'Payouts' },
  ];
  protected readonly payoutLabel = PAYOUT_LABEL;
  protected readonly payoutTone = PAYOUT_STATUS_TONE;

  // Lazy: the `scope` input is only set after construction (loaded in ngOnInit).
  protected readonly settlements = pagedList(
    (page, limit) => this.api.settlements(this.scope(), page, limit),
    {
      limit: 10,
      lazy: true,
      errorText: 'Could not load your settlements.',
    },
  );
  protected readonly payouts = pagedList(
    (page, limit) => this.api.payouts(this.scope(), page, limit),
    {
      limit: 10,
      lazy: true,
      errorText: 'Could not load your payouts.',
    },
  );

  ngOnInit(): void {
    this.settlements.load(1);
  }

  protected select(value: unknown): void {
    if (value !== 'settlements' && value !== 'payouts') return;
    this.view.set(value);
    if (value === 'payouts' && !this.payouts.data()) this.payouts.load(1);
  }

  protected statement(p: Payout): void {
    this.api.statement(this.scope(), p.id).catch((err: Error) => this.notify.error(err.message));
  }
}
