import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { CartService } from '../../core/services/cart.service';
import { AddressService, OrderService } from '../../core/services/checkout-api.service';
import { PaymentService } from '../../core/services/payment.service';
import { CartQuote } from '../../shared/models/checkout.models';
import { Checkout } from './checkout';

const quote = (overrides: Partial<CartQuote> = {}): CartQuote => ({
  cart: {
    id: 'c1',
    restaurant: { id: 'r1', name: 'Spice Route Kitchen', slug: 'spice-route-kitchen', isOpenNow: true, minOrderPaise: 0, avgPrepTimeMinutes: 25 },
    items: [{ foodItemId: 'f1', name: 'Butter Chicken', isVeg: false, unitPricePaise: 34900, quantity: 2, lineTotalPaise: 69800, isAvailable: true }],
    itemCount: 2,
  },
  coupon: null,
  couponError: null,
  address: { id: 'a1' } as CartQuote['address'],
  delivery: { distanceMeters: 4000, distanceKind: 'straight_line', freeDelivery: true, freeDeliveryThresholdPaise: 49900 },
  pricing: { subtotalPaise: 69800, discountPaise: 0, deliveryFeePaise: 0, platformFeePaise: 500, taxPaise: 3490, totalPaise: 73790 },
  issues: [],
  canCheckout: true,
  ...overrides,
});

describe('Checkout', () => {
  let fixture: ComponentFixture<Checkout>;
  const quoteSignal = signal<CartQuote | null>(null);
  const cart = {
    quote: quoteSignal.asReadonly(),
    busy: signal(false).asReadonly(),
    refresh: vi.fn(),
    selectedAddressId: signal<string | null>(null),
    reset: vi.fn(),
    selectAddress: vi.fn(),
  };
  const orders = { place: vi.fn(), availableCoupons: vi.fn(() => of([])) };
  const payments = {
    methods$: of([
      { method: 'cod', label: 'Cash on delivery', provider: 'cash_on_delivery', simulated: false },
      { method: 'online', label: 'Test payment (simulated, no real money)', provider: 'mock', simulated: true },
    ]),
    pay: vi.fn(),
    abandon: vi.fn(() => of({ restored: true })),
  };

  beforeEach(async () => {
    quoteSignal.set(quote());
    cart.refresh.mockReset().mockImplementation(() => of(quoteSignal()));
    cart.reset.mockReset();
    orders.place.mockReset();
    payments.pay.mockReset();
    payments.abandon.mockClear();
    await TestBed.configureTestingModule({
      imports: [Checkout],
      providers: [
        provideRouter([]),
        { provide: CartService, useValue: cart },
        { provide: OrderService, useValue: orders },
        { provide: AddressService, useValue: { list: () => of([]) } },
        { provide: PaymentService, useValue: payments },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Checkout);
    await fixture.whenStable();
  });

  const placeButton = () => (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button.place')!;

  it('shows the server total on the place-order button', () => {
    expect(placeButton().textContent).toContain('₹737.90');
    expect(placeButton().disabled).toBe(false);
  });

  it('disables ordering while the server reports blocking issues', async () => {
    quoteSignal.set(quote({ canCheckout: false, issues: [{ code: 'RESTAURANT_CLOSED', message: 'Closed now' }] }));
    await fixture.whenStable();
    expect(placeButton().disabled).toBe(true);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Closed now');
  });

  it('sends the total the customer saw and navigates to the order', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    orders.place.mockReturnValue(of({ order: { id: 'o1' }, checkout: null }));
    placeButton().click();
    expect(orders.place).toHaveBeenCalledWith(
      expect.objectContaining({ addressId: 'a1', paymentMethod: 'cod', expectedTotalPaise: 73790 }),
      expect.any(String),
    );
    expect(cart.reset).toHaveBeenCalled();
    expect(payments.pay).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/orders', 'o1'], { queryParams: { placed: 1 } });
  });

  it('pays online with the checkout session, then opens the order', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const checkout = { provider: 'mock', simulated: true, providerOrderId: 'mock_order_1', amountPaise: 73790, currency: 'INR', orderNumber: 'BB-1' };
    orders.place.mockReturnValue(of({ order: { id: 'o1' }, checkout }));
    payments.pay.mockResolvedValue({ status: 'paid' });
    const online = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('mat-radio-button[value="online"] input')!;
    expect(online).toBeTruthy();
    online.click();
    await fixture.whenStable();
    expect(placeButton().textContent).toContain('Place order & pay');
    placeButton().click();
    await fixture.whenStable();
    expect(orders.place).toHaveBeenCalledWith(expect.objectContaining({ paymentMethod: 'online' }), expect.any(String));
    expect(payments.pay).toHaveBeenCalledWith('o1', checkout);
    expect(navigate).toHaveBeenCalledWith(['/orders', 'o1'], { queryParams: { placed: 1 } });
  });

  it('reuses the same idempotency key when retrying after a network error', async () => {
    orders.place.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 0 })));
    placeButton().click();
    await fixture.whenStable();
    placeButton().click();
    const [first, second] = orders.place.mock.calls.map((call) => call[1]);
    expect(first).toBe(second);
  });

  it('refreshes prices and uses a new key when prices changed', async () => {
    orders.place.mockReturnValue(
      throwError(() => new HttpErrorResponse({ status: 409, error: { message: 'Prices changed', error: { code: 'PRICE_CHANGED' } } })),
    );
    placeButton().click();
    await fixture.whenStable();
    expect(cart.refresh).toHaveBeenCalledTimes(2); // initial load + refresh after the conflict
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Prices changed');
    placeButton().click();
    const [first, second] = orders.place.mock.calls.map((call) => call[1]);
    expect(first).not.toBe(second);
  });

  it('closing the payment page cancels the attempt and stays on checkout', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const checkout = { provider: 'mock', simulated: true, providerOrderId: 'mock_order_1', amountPaise: 73790, currency: 'INR', orderNumber: 'BB-1' };
    orders.place.mockReturnValue(of({ order: { id: 'o1' }, checkout }));
    payments.pay.mockResolvedValue(null);
    (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('mat-radio-button[value="online"] input')!.click();
    await fixture.whenStable();
    placeButton().click();
    await fixture.whenStable();
    expect(payments.abandon).toHaveBeenCalledWith('o1');
    expect(navigate).not.toHaveBeenCalled();
    expect(cart.reset).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('your order was not placed');
    expect(placeButton().disabled).toBe(false);
  });
});
