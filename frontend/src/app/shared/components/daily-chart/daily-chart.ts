import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChartComponent } from 'nexprime';

export const SERIES_COLORS = ['#2a78d6', '#1baf7a'] as const;

export interface DailySeries {
  label: string;
  values: number[];
}

@Component({
  selector: 'bb-daily-chart',
  imports: [ChartComponent],
  templateUrl: './daily-chart.html',
  styleUrl: './daily-chart.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DailyChart {
  readonly title = input.required<string>();
  readonly dates = input.required<string[]>();
  readonly series = input.required<DailySeries[]>();
  readonly format = input<(value: number) => string>((v) => String(v));
  readonly height = input(220);

  protected readonly labels = computed(() => this.dates().map(shortDay));
  protected readonly datasets = computed(() =>
    this.series().map((s, i) => ({ label: s.label, data: s.values, color: SERIES_COLORS[i] })),
  );
  protected readonly type = computed(() => (this.series().length > 1 ? 'line' : 'bar'));
  protected readonly empty = computed(() => this.series().every((s) => s.values.every((v) => !v)));
  protected readonly rows = computed(() =>
    this.dates().map((date, i) => ({
      date: shortDay(date),
      values: this.series().map((s) => s.values[i] ?? 0),
    })),
  );
}

function shortDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
