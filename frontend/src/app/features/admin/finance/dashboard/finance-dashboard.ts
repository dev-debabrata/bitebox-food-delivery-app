import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from 'nexprime';
import { FinanceService } from '../../../../core/services/admin/finance.service';
import { DailyChart } from '../../../../shared/components/daily-chart/daily-chart';
import { PageHeader } from '../../../../shared/components/page-header/page-header';
import { StatTile } from '../../../../shared/components/stat-tile/stat-tile';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { periodReport } from '../../../../shared/list/period-report';
import { formatPaise } from '../../../../shared/pipes/money.pipes';

@Component({
  selector: 'bb-finance-dashboard',
  imports: [RouterLink, MatButtonModule, IconComponent, NP_FORM_FIELDS, PageHeader, StatTile, DailyChart],
  templateUrl: './finance-dashboard.html',
  styleUrl: './finance-dashboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FinanceDashboardPage {
  private readonly api = inject(FinanceService);
  protected readonly report = periodReport((days) => this.api.dashboard(days), 'Could not load finance figures.');
  protected readonly money = (paise: number) => formatPaise(paise) || '₹0';

  private readonly daily = computed(() => this.report.data()?.daily ?? []);
  protected readonly dates = computed(() => this.daily().map((d) => d.date));
  protected readonly revenueSeries = computed(() => [
    { label: 'Collected', values: this.daily().map((d) => d.revenuePaise) },
  ]);

  /** Where delivered orders' money went: restaurants, riders and BiteBox. */
  protected readonly split = computed(() => {
    const t = this.report.data()?.totals;
    if (!t) return [];
    const rows = [
      { label: 'Restaurants', paise: t.restaurantEarningsPaise },
      { label: 'Delivery partners', paise: t.riderEarningsPaise },
      { label: 'BiteBox (commission and fees)', paise: t.platformCommissionPaise },
    ];
    const total = rows.reduce((n, r) => n + r.paise, 0) || 1;
    return rows.map((r) => ({ ...r, share: r.paise / total }));
  });
}
