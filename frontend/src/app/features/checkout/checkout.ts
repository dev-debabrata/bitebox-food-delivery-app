import { NpIconPipe } from '../../shared/icons/np-icon-name';
import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormRoot, form, maxLength, pattern } from '@angular/forms/signals';
import { TitleCasePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatRadioModule } from '@angular/material/radio';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, filter, firstValueFrom, of } from 'rxjs';
import { errorCode, errorMessage } from '../../core/services/api-error';
import { CartActions } from '../../core/services/cart-actions.service';
import { CartService } from '../../core/services/cart.service';
import { DeliveryLocationService } from '../../core/services/delivery-location.service';
import { AddressService, OrderService } from '../../core/services/checkout-api.service';
import { NotificationService } from '../../core/services/notification.service';
import { PaymentService } from '../../core/services/payment.service';
import { CheckoutSession, PaymentMethod } from '../../shared/models/payment.models';
import { AddressFormDialog } from '../../shared/components/address-form-dialog/address-form-dialog';
import { BillSummary } from '../../shared/components/bill-summary/bill-summary';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { QtyStepper } from '../../shared/components/qty-stepper/qty-stepper';
import { VegBadge } from '../../shared/components/veg-badge/veg-badge';
import { CouponOffer, DeliveryAddress } from '../../shared/models/checkout.models';
import { InrPipe } from '../../shared/pipes/money.pipes';

/**
 * Random key for the Idempotency-Key header. crypto.randomUUID() only exists on
 * secure origins (https / localhost), so fall back to getRandomValues elsewhere
 * (e.g. testing from a phone over the LAN).
 */
function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Cart + checkout on one page: items, coupon, delivery address, payment,
 * bill and the "Place order" action. Every number shown comes from the server.
 */
import { shownError } from '../../shared/forms/form-errors';
import { NP_FORM_FIELDS } from '../../shared/forms/np-form-fields';

@Component({
  selector: 'bb-checkout',
  imports: [
    FormRoot,
    NP_FORM_FIELDS,
    RouterLink,
    MatButtonModule,
    IconComponent, NpIconPipe,
    MatProgressSpinnerModule,
    MatRadioModule,
    BillSummary,
    EmptyState,
    QtyStepper,
    VegBadge,
    InrPipe,
    TitleCasePipe,
  ],
  templateUrl: './checkout.html',
  styleUrl: './checkout.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Checkout {
  protected readonly cart = inject(CartService);
  protected readonly cartActions = inject(CartActions);
  private readonly addresses = inject(AddressService);
  private readonly orders = inject(OrderService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly payments = inject(PaymentService);

  protected readonly quote = this.cart.quote;
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly savedAddresses = signal<DeliveryAddress[]>([]);
  protected readonly offers = signal<CouponOffer[]>([]);
  protected readonly shownError = shownError;
  protected readonly couponForm = form(
    signal({ code: '' }),
    (path) => {
      pattern(path.code, /^\s*[A-Za-z0-9_-]{3,30}\s*$/, { message: 'Coupon codes are 3-30 letters or digits' });
    },
    { submission: { action: async () => this.applyCoupon() } },
  );
  protected readonly couponError = signal<string | null>(null);
  protected readonly applyingCoupon = signal(false);
  protected readonly noteForm = form(signal({ note: '' }), (path) => {
    maxLength(path.note, 300, { message: 'Keep the note under 300 characters' });
  });
  /** Cash on delivery is always offered; online only when the server says so (not if that cannot be loaded). */
  private readonly methods = toSignal(this.payments.methods$.pipe(catchError(() => of([]))), { initialValue: [] });
  protected readonly onlineAvailable = computed(() => this.methods().some((m) => m.method === 'online'));
  protected readonly paymentMethod = signal<PaymentMethod>('cod');
  protected readonly placing = signal(false);
  protected readonly placeError = signal<string | null>(null);

  /** One key per checkout attempt; reused on retry so a flaky network cannot create two orders. */
  private idempotencyKey = newIdempotencyKey();

  protected readonly selectedAddressId = computed(() => this.quote()?.address?.id ?? null);
  protected readonly blockingIssues = computed(() => (this.quote()?.issues ?? []).filter((i) => i.code !== 'NO_ADDRESS'));

  constructor() {
    // If the delivery location in the header is a saved address, start with that address.
    const location = inject(DeliveryLocationService).location();
    if (location?.source === 'address' && location.addressId && !this.cart.selectedAddressId()) {
      this.cart.selectedAddressId.set(location.addressId);
    }
    this.cart.refresh().subscribe({
      next: (quote) => {
        this.loading.set(false);
        if (quote.cart?.restaurant) this.loadOffers(quote.cart.restaurant.id);
      },
      error: (err: unknown) => {
        this.loadError.set(errorMessage(err, 'Could not load your cart.'));
        this.loading.set(false);
      },
    });
    this.addresses.list().subscribe({ next: (list) => this.savedAddresses.set(list) });
  }

  private loadOffers(restaurantId: string): void {
    this.orders.availableCoupons(restaurantId).subscribe({ next: (list) => this.offers.set(list), error: () => this.offers.set([]) });
  }

  protected applyCoupon(code = this.couponForm.code().value()): void {
    const value = code.trim();
    if (!value) return;
    this.applyingCoupon.set(true);
    this.couponError.set(null);
    this.cart.applyCoupon(value).subscribe({
      next: (quote) => {
        this.applyingCoupon.set(false);
        this.couponForm().reset({ code: '' });
        this.notify.success(`${quote.coupon?.code} applied — you save ₹${(quote.pricing.discountPaise / 100).toFixed(0)}`);
      },
      error: (err: unknown) => {
        this.couponError.set(errorMessage(err));
        this.applyingCoupon.set(false);
      },
    });
  }

  protected removeCoupon(): void {
    this.cart.removeCoupon().subscribe({ error: (err: unknown) => this.notify.error(errorMessage(err)) });
  }

  protected selectAddress(id: string): void {
    this.cart.selectAddress(id).subscribe({ error: (err: unknown) => this.notify.error(errorMessage(err)) });
  }

  protected addAddress(): void {
    this.dialog
      .open<AddressFormDialog, DeliveryAddress | null, DeliveryAddress>(AddressFormDialog, { data: null, width: '640px', maxWidth: '95vw', autoFocus: 'first-tabbable' })
      .afterClosed()
      .pipe(filter((a): a is DeliveryAddress => !!a))
      .subscribe((address) => {
        this.savedAddresses.update((list) => [address, ...list.map((a) => (address.isDefault ? { ...a, isDefault: false } : a))]);
        this.selectAddress(address.id);
      });
  }

  protected clearCart(): void {
    this.cart.clear().subscribe();
  }

  protected placeOrder(): void {
    const quote = this.quote();
    const addressId = this.selectedAddressId();
    if (!quote?.canCheckout || !addressId || this.noteForm().invalid()) return;

    this.placing.set(true);
    this.placeError.set(null);
    this.orders
      .place(
        { addressId, paymentMethod: this.paymentMethod(), note: this.noteForm.note().value().trim() || undefined, expectedTotalPaise: quote.pricing.totalPaise },
        this.idempotencyKey,
      )
      .subscribe({
        next: async ({ order, checkout }) => {
          this.idempotencyKey = newIdempotencyKey();
          if (checkout && !(await this.payOnline(order.id, checkout))) return;
          this.cart.reset();
          void this.router.navigate(['/orders', order.id], { queryParams: { placed: 1 } });
        },
        error: (err: unknown) => {
          this.placing.set(false);
          const code = errorCode(err);
          // The cart/prices changed under us: show the fresh numbers and let the customer re-confirm.
          if (code === 'PRICE_CHANGED' || code === 'CART_CHANGED' || code === 'CHECKOUT_BLOCKED' || code === 'COUPON_INVALID' || code === 'COUPON_EXHAUSTED') {
            this.idempotencyKey = newIdempotencyKey();
            this.cart.refresh().subscribe();
          }
          this.placeError.set(errorMessage(err, 'Could not place your order. Please try again.'));
        },
      });
  }

  /**
   * Opens the gateway. True once paid. Otherwise (closed or failed) the attempt
   * is cancelled and the cart refilled, so nothing is ordered and the customer
   * stays on checkout to retry or choose cash.
   */
  private async payOnline(orderId: string, checkout: CheckoutSession): Promise<boolean> {
    let failure: string | null = 'Payment was not completed, so your order was not placed. Your cart is still here.';
    try {
      const payment = await this.payments.pay(orderId, checkout);
      if (payment?.status === 'paid') return true;
      if (payment?.status === 'failed') failure = `Payment failed${payment.failureReason ? ` (${payment.failureReason})` : ''}. Your order was not placed. Please try again.`;
    } catch (err: unknown) {
      failure = errorMessage(err, 'Payment could not be completed.') + ' Your order was not placed.';
    }
    try {
      await firstValueFrom(this.payments.abandon(orderId));
    } catch (err: unknown) {
      // Paid in the meantime (e.g. the gateway confirmed late): it is a real order after all.
      if (errorCode(err) === 'ORDER_PLACED') return true;
    }
    this.placing.set(false);
    this.placeError.set(failure);
    this.cart.refresh().subscribe();
    return false;
  }

  protected addressLine(a: DeliveryAddress): string {
    return [a.line1, a.line2, a.area, a.city].filter(Boolean).join(', ');
  }

  protected offerTitle(o: CouponOffer): string {
    return o.discountType === 'percent' ? `${o.discountValue}% off` : `₹${o.discountValue / 100} off`;
  }
}
