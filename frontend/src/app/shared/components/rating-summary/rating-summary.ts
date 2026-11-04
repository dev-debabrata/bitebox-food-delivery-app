import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RatingSummary as Summary } from '../../models/review.models';
import { Stars } from '../stars/stars';

/**
 * Average, count and the 5-to-1 star breakdown. With `filterable`, each row is a toggle button
 * that filters a list by that star value.
 */
@Component({
  selector: 'bb-rating-summary',
  imports: [Stars],
  templateUrl: './rating-summary.html',
  styleUrl: './rating-summary.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RatingSummary {
  readonly summary = input.required<Summary>();
  readonly noun = input('review');
  readonly filterable = input(false);
  readonly selected = input<number | null>(null);
  readonly pick = output<number | null>();

  protected readonly average = computed(() => this.summary().average.toFixed(1));
  protected readonly rows = computed(() => {
    const { distribution = [0, 0, 0, 0, 0], count } = this.summary();
    return [5, 4, 3, 2, 1].map((stars) => {
      const n = distribution[stars - 1] ?? 0;
      return { stars, n, percent: count ? Math.round((n / count) * 100) : 0 };
    });
  });

  protected plural(n: number): string {
    return `${n} ${this.noun()}${n === 1 ? '' : 's'}`;
  }

  protected toggle(stars: number): void {
    this.pick.emit(this.selected() === stars ? null : stars);
  }
}
