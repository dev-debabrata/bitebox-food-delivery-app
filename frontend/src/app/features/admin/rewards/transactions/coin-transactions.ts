import { TableLabels } from '../../../../shared/list/table-labels';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatPaginatorModule } from '@angular/material/paginator';
import { IconComponent, SelectOption } from 'nexprime';
import { filter } from 'rxjs';
import { AuthService } from '../../../../core/auth/auth.service';
import { AdminRewardsService } from '../../../../core/services/admin/admin-rewards.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { EmptyState } from '../../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { pagedList } from '../../../../shared/list/paged-list';
import {
  AdminCoinTransaction,
  CoinSource,
  CoinTxnType,
  SOURCE_LABEL,
  TXN_TYPE_LABEL,
} from '../../../../shared/models/rewards.models';
import { ReverseDialog } from '../reverse-dialog/reverse-dialog';
import { WalletDialog } from '../wallet-dialog/wallet-dialog';

/** The coin ledger across all customers, with wallet details and reward reversals. */
@Component({
  selector: 'bb-coin-transactions',
  imports: [
    TableLabels,DatePipe, NP_FORM_FIELDS, MatButtonModule, MatPaginatorModule, IconComponent, EmptyState, PageHeader],
  templateUrl: './coin-transactions.html',
  styleUrl: './coin-transactions.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CoinTransactionsPage {
  private readonly api = inject(AdminRewardsService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);
  protected readonly canManage = inject(AuthService).can('rewards:manage');
  protected readonly sourceLabel = SOURCE_LABEL;
  protected readonly typeLabel = TXN_TYPE_LABEL;
  /** ?userId= from other pages (one customer's history). */
  readonly userId = input<string>();

  protected readonly filterModel = signal({ search: '', type: '', source: '', userId: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly typeOptions: SelectOption[] = [
    { value: '', label: 'Any type' },
    ...Object.entries(TXN_TYPE_LABEL).map(([value, label]) => ({ value, label })),
  ];
  protected readonly sourceOptions: SelectOption[] = [
    { value: '', label: 'Any source' },
    ...Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label })),
  ];

  constructor() {
    effect(() => {
      const id = this.userId() ?? '';
      untracked(() => this.filterModel.update((f) => ({ ...f, userId: id })));
    });
  }

  protected readonly list = pagedList(
    (page, limit) => {
      const f = this.filterModel();
      return this.api.transactions({
        search: f.search.trim() || undefined,
        type: (f.type || undefined) as CoinTxnType | undefined,
        source: (f.source || undefined) as CoinSource | undefined,
        userId: f.userId || undefined,
        page,
        limit,
      });
    },
    { filterKey: () => JSON.stringify(this.filterModel()), errorText: 'Could not load coin transactions.' },
  );

  protected clearCustomer(): void {
    this.filterModel.update((f) => ({ ...f, userId: '' }));
  }

  protected wallet(t: AdminCoinTransaction): void {
    if (t.customer) this.dialog.open(WalletDialog, { data: t.customer.id, width: '760px', maxWidth: '95vw' });
  }

  protected reverse(t: AdminCoinTransaction): void {
    this.dialog
      .open<ReverseDialog, AdminCoinTransaction, AdminCoinTransaction>(ReverseDialog, { data: t, width: '480px', maxWidth: '95vw' })
      .afterClosed()
      .pipe(filter(Boolean))
      .subscribe((row) => {
        this.notify.success(
          row.shortfall ? `${row.coins} coins reversed; ${row.shortfall} were already spent` : `${row.coins} coins reversed`,
        );
        this.list.reload();
      });
  }

  protected change(t: AdminCoinTransaction): string {
    const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
    if (t.availableChange) return sign(t.availableChange);
    if (t.reservedChange) return `held ${sign(t.reservedChange)}`;
    return '0';
  }
}
