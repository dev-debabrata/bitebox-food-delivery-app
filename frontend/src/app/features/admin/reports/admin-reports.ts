import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ReportsService } from '../../../core/services/reports.service';
import { DailyChart, SERIES_COLORS } from '../../../shared/components/daily-chart/daily-chart';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { StatTile } from '../../../shared/components/stat-tile/stat-tile';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { periodReport } from '../../../shared/list/period-report';
import { ORDER_STATUS_LABEL, OrderStatus } from '../../../shared/models/checkout.models';
import { InrPipe, formatPaise } from '../../../shared/pipes/money.pipes';

const METHOD_LABEL: Record<string, string> = { cod: 'Cash on delivery', online: 'Online' };

interface ShareRow {
  label: string;
  value: string;
  share: number;
}

function shares(rows: { label: string; n: number; value: string }[]): ShareRow[] {
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  return [...rows]
    .sort((a, b) => b.n - a.n)
    .map((r) => ({ label: r.label, value: r.value, share: total ? r.n / total : 0 }));
}

@Component({
  selector: 'bb-admin-reports',
  imports: [DecimalPipe, NP_FORM_FIELDS, IconComponent, DailyChart, PageHeader, StatTile, InrPipe],
  templateUrl: './admin-reports.html',
  styleUrl: './admin-reports.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminReports {
  private readonly api = inject(ReportsService);

  protected readonly report = periodReport(
    (days) => this.api.adminReport(days),
    'Could not load the report.',
  );
  protected readonly formatPaise = formatPaise;
  protected readonly count = String;
  protected readonly barColor = SERIES_COLORS[0];

  private readonly daily = computed(() => this.report.data()?.daily ?? []);
  protected readonly dates = computed(() => this.daily().map((d) => d.date));
  protected readonly gmvSeries = computed(() => [
    { label: 'Delivered value', values: this.daily().map((d) => d.gmvPaise) },
  ]);
  protected readonly orderSeries = computed(() => [
    { label: 'Placed', values: this.daily().map((d) => d.orders) },
    { label: 'Delivered', values: this.daily().map((d) => d.delivered) },
  ]);

  protected readonly breakdowns = computed(() => {
    const d = this.report.data();
    const counts = d?.statusCounts ?? {};
    return [
      {
        title: 'Payment mix',
        note: 'Share of delivered value',
        empty: 'No delivered orders yet.',
        rows: shares(
          (d?.paymentMix ?? []).map((m) => ({
            label: METHOD_LABEL[m.method] ?? m.method,
            n: m.paise,
            value: `${formatPaise(m.paise)} · ${m.orders} ${m.orders === 1 ? 'order' : 'orders'}`,
          })),
        ),
      },
      {
        title: 'Order outcomes',
        note: 'Current status of orders placed in the period',
        empty: 'No orders yet.',
        rows: shares(
          (Object.keys(counts) as OrderStatus[]).map((s) => ({
            label: ORDER_STATUS_LABEL[s],
            n: counts[s]!,
            value: String(counts[s]),
          })),
        ),
      },
    ];
  });

  protected readonly deliveryRate = computed(() => {
    const t = this.report.data()?.totals;
    return t?.orders
      ? `${Math.round((t.delivered / t.orders) * 100)}% of ${t.orders} placed`
      : undefined;
  });
}
