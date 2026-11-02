import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** The familiar square veg (green) / non-veg (red) marker, with a text label for screen readers. */
@Component({
  selector: 'bb-veg-badge',
  templateUrl: './veg-badge.html',
  styleUrl: './veg-badge.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VegBadge {
  readonly veg = input.required<boolean>();
}
