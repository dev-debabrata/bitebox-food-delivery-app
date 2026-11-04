import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { EarningsScope, ReportsService } from '../../core/services/reports.service';
import { DailyChart } from '../../shared/components/daily-chart/daily-chart';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { StatTile } from '../../shared/components/stat-tile/stat-tile';
import { NP_FORM_FIELDS } from '../../shared/forms/np-form-fields';
import { periodReport } from '../../shared/list/period-report';
import { InrPipe, formatDistance, formatPaise } from '../../shared/pipes/money.pipes';

@Component({
  selector: 'bb-earnings-page',
  imports: [
    DatePipe,
    NP_FORM_FIELDS,
    IconComponent,
    DailyChart,
    EmptyState,
    PageHeader,
    StatTile,
    InrPipe,
  ],
  templateUrl: './earnings-page.html',
  styleUrl: './earnings-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EarningsPage {
  private readonly api = inject(ReportsService);
  readonly scope = input<EarningsScope>('restaurant');

  protected readonly report = periodReport(
    (days) => this.api.earnings(this.scope(), days),
    'Could not load your earnings.',
  );
  protected readonly formatPaise = formatPaise;
  protected readonly distance = formatDistance;

  protected readonly rider = computed(() => this.scope() === 'rider');
  protected readonly dates = computed(() => this.report.data()?.daily.map((d) => d.date) ?? []);
  protected readonly series = computed(() => [
    { label: 'Earnings', values: this.report.data()?.daily.map((d) => d.earningsPaise) ?? [] },
  ]);
  protected readonly perOrder = computed(() => {
    const t = this.report.data()?.totals;
    return t?.orders ? formatPaise(Math.round(t.earningsPaise / t.orders)) : '–';
  });
}
