import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'bb-veg-badge',
  templateUrl: './veg-badge.html',
  styleUrl: './veg-badge.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VegBadge {
  readonly veg = input.required<boolean>();
}
