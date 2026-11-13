import { TableLabels } from '../../../../shared/list/table-labels';
import { CommissionRates } from './commission-rates/commission-rates';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { IconComponent } from 'nexprime';
import { FinanceService } from '../../../../core/services/admin/finance.service';
import { PageHeader } from '../../../../shared/components/page-header/page-header';
import { StatTile } from '../../../../shared/components/stat-tile/stat-tile';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { periodReport } from '../../../../shared/list/period-report';
import { InrPipe, formatPaise } from '../../../../shared/pipes/money.pipes';

/** Commission rates and what they earned per restaurant over the period. */
@Component({
  selector: 'bb-commission',
  imports: [
    TableLabels,
    IconComponent,
    NP_FORM_FIELDS,
    PageHeader,
    StatTile,
    InrPipe,
    CommissionRates,
  ],
  templateUrl: './commission.html',
  styleUrl: './commission.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommissionPage {
  private readonly api = inject(FinanceService);
  protected readonly report = periodReport(
    (days) => this.api.commission(days),
    'Could not load commission.',
  );
  protected readonly money = (paise: number) => formatPaise(paise) || '₹0';
}
