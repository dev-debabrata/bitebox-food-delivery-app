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

  beforeEach(async () => {
    displayUser.set(null);
    initialised.set(false);

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
            enabled: signal(false),
            itemCount: signal(0),
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
});
