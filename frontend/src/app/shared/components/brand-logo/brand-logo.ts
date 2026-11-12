import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'bb-brand-logo',
  templateUrl: './brand-logo.html',
  styleUrl: './brand-logo.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrandLogo {
  /** `light`: always the light-on-dark logo (dark brand surfaces). `default` follows the theme. */
  readonly variant = input<'default' | 'light'>('default');
  readonly height = input(36);
}
