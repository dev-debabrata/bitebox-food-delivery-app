import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';
import { CartService } from './cart.service';
import { DeliveryLocationService } from './delivery-location.service';
import { GeolocationService } from './geolocation.service';

describe('CartService', () => {
  let cart: CartService;
  let location: DeliveryLocationService;
  let http: HttpTestingController;
  const url = `${environment.apiUrl}/cart`;
  const quote = { cart: null, pricing: null, issues: [], address: { id: 'default-1' } };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        // Signed out, so the constructor doesn't load the cart by itself.
        { provide: AuthService, useValue: { role: signal(null) } },
        { provide: GeolocationService, useValue: {} },
      ],
    });
    cart = TestBed.inject(CartService);
    location = TestBed.inject(DeliveryLocationService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('falls back to the default address when the remembered one is not on this account', async () => {
    location.location.set({ label: 'Maple Town', latitude: 10, longitude: 20, source: 'address', addressId: 'gone-1' });
    cart.selectedAddressId.set('gone-1');

    const result = firstValueFrom(cart.refresh());
    http
      .expectOne((r) => r.url === url && r.params.get('addressId') === 'gone-1')
      .flush({ success: false, message: 'Address not found' }, { status: 404, statusText: 'Not Found' });
    http
      .expectOne((r) => r.url === url && !r.params.has('addressId'))
      .flush({ success: true, message: 'OK', data: quote });

    expect((await result).address?.id).toBe('default-1');
    expect(cart.selectedAddressId()).toBeNull();
    // The point stays as the delivery location; only the dead address link is dropped.
    expect(location.location()).toMatchObject({ label: 'Maple Town', source: 'search', addressId: undefined });
  });

  it('still reports other failures', async () => {
    const result = firstValueFrom(cart.refresh());
    http
      .expectOne(url)
      .flush({ success: false, message: 'Server error' }, { status: 500, statusText: 'Server Error' });
    await expect(result).rejects.toMatchObject({ status: 500 });
  });
});
