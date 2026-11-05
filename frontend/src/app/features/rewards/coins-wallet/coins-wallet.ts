import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { form } from '@angular/forms/signals';
import { MatPaginatorModule } from '@angular/material/paginator';
import { RouterLink } from '@angular/router';
import { IconComponent, SelectOption } from 'nexprime';
import { resourceError, resourceValue } from '../../../core/services/api-error';
import { RewardsService } from '../../../core/services/rewards.service';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { StatTile } from '../../../shared/components/stat-tile/stat-tile';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { pagedList } from '../../../shared/list/paged-list';
import {
  CoinTransaction,
  CoinTxnType,
  SOURCE_LABEL,
  TXN_TYPE_LABEL,
} from '../../../shared/models/rewards.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';
import { RewardsNav } from '../rewards-nav/rewards-nav';

/** My Coins & Wallet: balances, upcoming expiry, how to earn, and the full history. */
@Component({
  selector: 'bb-coins-wallet',
  imports: [
    DatePipe,
    RouterLink,
    MatPaginatorModule,
    IconComponent,
    NP_FORM_FIELDS,
    EmptyState,
    PageHeader,
    StatTile,
    InrPipe,
    RewardsNav,
  ],
  templateUrl: './coins-wallet.html',
  styleUrl: './coins-wallet.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CoinsWallet {
  private readonly api = inject(RewardsService);
  protected readonly sourceLabel = SOURCE_LABEL;
  protected readonly typeLabel = TXN_TYPE_LABEL;

  protected readonly summary = rxResource({ stream: () => this.api.wallet() });
  protected readonly data = resourceValue(this.summary);
  protected readonly summaryError = resourceError(this.summary, 'Could not load your wallet.');

  protected readonly filterModel = signal({ type: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly typeOptions: SelectOption[] = [
    { value: '', label: 'All activity' },
    { value: 'CREDIT', label: 'Earned' },
    { value: 'DEBIT', label: 'Redeemed' },
    { value: 'RESERVE', label: 'Held for orders' },
    { value: 'RELEASE', label: 'Returned' },
    { value: 'EXPIRE', label: 'Expired' },
    { value: 'REVERSAL', label: 'Reversals and refunds' },
  ];

  protected readonly list = pagedList(
    (page, limit) =>
      this.api.transactions({ type: (this.filterModel().type || undefined) as CoinTxnType | undefined, page, limit }),
    { filterKey: () => this.filterModel().type, errorText: 'Could not load your coin history.' },
  );

  /** "+50", "−100", or "Spent" for a redeemed hold (it already left the balance when held). */
  protected change(t: CoinTransaction): string {
    if (t.availableChange > 0) return `+${t.availableChange}`;
    if (t.availableChange < 0) return `−${-t.availableChange}`;
    if (t.type === 'DEBIT') return `${t.coins} spent`;
    return '0';
  }

  protected tone(t: CoinTransaction): string {
    if (t.availableChange > 0) return 'up';
    if (t.availableChange < 0) return 'down';
    return 'flat';
  }
}
