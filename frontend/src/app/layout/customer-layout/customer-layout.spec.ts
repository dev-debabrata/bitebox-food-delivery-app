import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthService } from '../../core/auth/auth.service';
import { CartService } from '../../core/services/cart.service';
import { DeliveryLocationService } from '../../core/services/delivery-location.service';
import { CustomerLayout } from './customer-layout';

describe('CustomerLayout', () => {
  let fixture: ComponentFixture<CustomerLayout>;
  const displayUser = signal<{ name: string; role: 'customer' | 'restaurant' | 'delivery' | 'admin' } | null>(null);
  const initialised = signal(false);
  const cartItemCount = signal(0);
  const cartEnabled = signal(true);

  beforeEach(async () => {
    displayUser.set(null);
    initialised.set(false);
    cartItemCount.set(0);
    cartEnabled.set(true);

    await TestBed.configureTestingModule({
      imports: [CustomerLayout],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: AuthService,
          useValue: {
            user: signal(null),
            displayUser,
            initialised,
            role: signal<'customer'>('customer'),
            logout: vi.fn(),
          },
        },
        {
          provide: CartService,
          useValue: {
            enabled: cartEnabled,
            itemCount: cartItemCount,
          },
        },
        {
          provide: DeliveryLocationService,
          useValue: {
            location: signal(null),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CustomerLayout);
  });

  const partnerLink = () => {
    const links = Array.from(fixture.nativeElement.querySelectorAll('.desktop-nav a')) as HTMLAnchorElement[];
    return links.find((a) => a.textContent?.includes('Partner with us'));
  };

  it('does not render "Partner with us" while session readiness is pending (preventing reload flicker)', async () => {
    initialised.set(false);
    displayUser.set(null);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(partnerLink()).toBeUndefined();
  });

  it('renders "Partner with us" once session is initialised for visitors', async () => {
    initialised.set(true);
    displayUser.set(null);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(partnerLink()).toBeDefined();
  });

  it('does not render "Partner with us" for signed-in users', async () => {
    initialised.set(true);
    displayUser.set({ name: 'Debabrata Das', role: 'customer' });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(partnerLink()).toBeUndefined();
  });

  it('hides the desktop cart icon when the cart is empty and reveals it when items are added', async () => {
    initialised.set(true);
    displayUser.set({ name: 'Debabrata Das', role: 'customer' });
    cartItemCount.set(0);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('.cart-button')).toBeNull();

    cartItemCount.set(3);
    fixture.detectChanges();
    await fixture.whenStable();

    const cartBtn = fixture.nativeElement.querySelector('.cart-button');
    expect(cartBtn).not.toBeNull();
    expect(cartBtn.textContent).toContain('3');
  });
});
