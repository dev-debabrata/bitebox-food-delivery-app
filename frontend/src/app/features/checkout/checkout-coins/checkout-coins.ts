import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from '@angular/core';
import { FormRoot, form, validate } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from 'nexprime';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { CoinQuote } from '../../../shared/models/rewards.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';

/**
 * The coins card on the checkout page. The amount shown and the discount come from the server's
 * quote; this only asks for a number of coins (the server checks balance, minimum and caps).
 */
@Component({
  selector: 'bb-checkout-coins',
  imports: [FormRoot, NP_FORM_FIELDS, MatButtonModule, IconComponent, InrPipe],
  templateUrl: './checkout-coins.html',
  styleUrl: './checkout-coins.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CheckoutCoins {
  readonly coins = input.required<CoinQuote>();
  readonly paymentMethod = input<'cod' | 'online'>('cod');
  readonly busy = input(false);
  readonly apply = output<number>();
  readonly remove = output<void>();

  protected readonly applied = computed(() => this.coins().applied > 0);
  protected readonly redeemable = computed(() => this.coins().maxRedeemable >= this.coins().minCoins);
  /** Rupee value of the most coins usable on this order. */
  protected readonly maxValuePaise = computed(() => {
    const c = this.coins();
    return Math.floor((c.maxRedeemable * c.coinValuePaise) / c.coinValueCoins);
  });
  protected readonly methodBlocked = computed(
    () => this.applied() && !this.coins().paymentMethods.includes(this.paymentMethod()),
  );

  protected readonly model = signal({ coins: null as number | null });
  protected readonly form = form(
    this.model,
    (path) => {
      validate(path.coins, ({ value }) => {
        const c = this.coins();
        const v = value();
        if (v === null || v === undefined) return { kind: 'required', message: 'Enter the coins to use' };
        if (!Number.isInteger(v)) return { kind: 'integer', message: 'Use whole coins' };
        if (v < c.minCoins) return { kind: 'min', message: `Use at least ${c.minCoins} coins` };
        if (v > c.maxRedeemable) return { kind: 'max', message: `Up to ${c.maxRedeemable} coins on this order` };
        return undefined;
      });
    },
    { submission: { action: async () => this.apply.emit(Number(this.model().coins)) } },
  );

  constructor() {
    // Suggest the most that can be used whenever the cart changes and nothing is applied.
    effect(() => {
      const c = this.coins();
      if (!c.applied && this.redeemable()) this.model.set({ coins: c.maxRedeemable });
    });
  }

  protected useMax(): void {
    this.apply.emit(this.coins().maxRedeemable);
  }
}
