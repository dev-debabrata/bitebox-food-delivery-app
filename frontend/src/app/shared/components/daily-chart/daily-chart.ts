import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChartComponent } from 'nexprime';

/** Categorical slots 1 and 3 of the validated chart palette (blue, aqua). */
export const SERIES_COLORS = ['#2a78d6', '#1baf7a'] as const;

export interface DailySeries {
  label: string;
  values: number[];
}

/**
 * A daily series chart (bars for one series, lines for two) with a
 * "Show as table" view, so the numbers never depend on reading colour.
 * `dates` are YYYY-MM-DD; `format` renders values (axis, tooltip, table).
 */
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
    this.dates().map((date, i) => ({ date: shortDay(date), values: this.series().map((s) => s.values[i] ?? 0) })),
  );
}

/** "2026-11-03" -> "3 Nov" (parsed as a calendar day, not a UTC instant). */
function shortDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
