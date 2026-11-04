import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Read-only stars with partial fill (4.3 fills 30% of the fifth star). One image for assistive
 * technology ("Rated 4.3 out of 5"); for picking a rating use np-rating instead.
 */
@Component({
  selector: 'bb-stars',
  templateUrl: './stars.html',
  styleUrl: './stars.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'img',
    '[attr.aria-label]': 'label()',
    '[class]': "'size-' + size()",
  },
})
export class Stars {
  readonly value = input.required<number>();
  readonly size = input<'sm' | 'md'>('md');
  /** Overrides the spoken label, e.g. "Not rated yet". */
  readonly ariaLabel = input<string>();

  protected readonly path =
    'M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.54L12 17.5l-5.87 3.08 1.12-6.54L2.5 9.41l6.56-.95z';
  protected readonly fills = computed(() =>
    [0, 1, 2, 3, 4].map((i) => Math.round(Math.max(0, Math.min(1, this.value() - i)) * 100)),
  );
  protected readonly label = computed(
    () => this.ariaLabel() ?? `Rated ${+this.value().toFixed(1)} out of 5`,
  );
}
