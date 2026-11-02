import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { of } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { AddressService } from '../../../core/services/checkout-api.service';
import { DeliveryLocationService } from '../../../core/services/delivery-location.service';
import { GeolocationService } from '../../../core/services/geolocation.service';
import { AddressFormDialog } from './address-form-dialog';

type Model = Record<string, unknown>;
type Internals = {
  model: { (): Model; update: (fn: (v: Model) => Model) => void };
  useCurrentLocation: () => Promise<void>;
  pinned: () => boolean;
};

describe('AddressFormDialog', () => {
  const geo = { supported: true, currentPrecise: vi.fn() };
  const places = { reverse: vi.fn() };
  const service = { create: vi.fn(), update: vi.fn() };

  async function create() {
    await TestBed.configureTestingModule({
      imports: [AddressFormDialog],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: null },
        { provide: MatDialogRef, useValue: { close: vi.fn() } },
        { provide: GeolocationService, useValue: geo },
        { provide: DeliveryLocationService, useValue: places },
        { provide: AddressService, useValue: service },
        { provide: AuthService, useValue: { user: () => ({ name: 'Asha', phone: '9000000002' }) } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(AddressFormDialog);
    await fixture.whenStable();
    return fixture;
  }

  it('pins GPS coordinates and fills only empty address fields', async () => {
    geo.currentPrecise.mockResolvedValue({ latitude: 10.5, longitude: 20.5, accuracy: 20 });
    places.reverse.mockReturnValue(
      of({ label: 'Test Area, Test City', displayName: 'Test Area, Test City, Test State', area: 'Test Area', city: 'Test City', state: 'Test State', postalCode: '100001', latitude: 10.5, longitude: 20.5 }),
    );
    const fixture = await create();
    const component = fixture.componentInstance as unknown as Internals;
    component.model.update((v) => ({ ...v, city: 'Sample City' })); // typed by the user: must be kept

    await component.useCurrentLocation();

    expect(component.pinned()).toBe(true);
    expect(component.model()).toEqual(
      expect.objectContaining({ latitude: 10.5, area: 'Test Area', city: 'Sample City', postalCode: '100001' }),
    );
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Delivering here');
  });

  it('refuses to save without a pinned location', async () => {
    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(service.create).not.toHaveBeenCalled();
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Pin your delivery location first');
  });
});
