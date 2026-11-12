import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'bb-brand-logo',
  templateUrl: './brand-logo.html',
  styleUrl: './brand-logo.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrandLogo {
  readonly variant = input<'default' | 'light'>('default');
  readonly height = input(36);
  protected readonly src = computed(() =>
    this.variant() === 'light' ? '/bitebox-logo-dark.svg' : '/bitebox-logo.svg',
  );
}
