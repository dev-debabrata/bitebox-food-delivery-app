import { TestBed } from '@angular/core/testing';
import { ApplicationRef } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../../environments/environment';
import { DeliveryAddress } from '../../shared/models/checkout.models';
import { DeliveryLocationService, extractAddressFromPlace } from './delivery-location.service';
import { GeolocationService } from './geolocation.service';

describe('DeliveryLocationService', () => {
  let service: DeliveryLocationService;
  let http: HttpTestingController;
  const geo = { currentPrecise: vi.fn(), supported: true };

  function setup() {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: GeolocationService, useValue: geo }],
    });
    service = TestBed.inject(DeliveryLocationService);
    http = TestBed.inject(HttpTestingController);
  }

  /** afterNextRender callbacks run after a render; trigger one. */
  const render = () => TestBed.inject(ApplicationRef).tick();

  beforeEach(() => localStorage.clear());
  afterEach(() => http.verify());

  it('is ready only once the saved location has been read', () => {
    localStorage.setItem('bb_delivery_location', JSON.stringify({ label: 'Maple Town', latitude: 10, longitude: 20, source: 'search' }));
    setup();
    expect(service.ready()).toBe(false);
    expect(service.location()).toBeNull();
    render();
    expect(service.ready()).toBe(true);
    expect(service.location()?.label).toBe('Maple Town');
  });

  it('names the current GPS position via reverse geocoding and remembers it', async () => {
    setup();
    render();
    geo.currentPrecise.mockResolvedValue({ latitude: 10.5, longitude: 20.5, accuracy: 20 });
    const pending = service.useCurrentLocation();
    await Promise.resolve();
    await Promise.resolve();
    http
      .expectOne((r) => r.url === `${environment.baseUrl}/geo/reverse`)
      .flush({ success: true, message: 'OK', data: { place: { label: 'Test Area, Test City', latitude: 10.5, longitude: 20.5 } } });
    const location = await pending;
    expect(location.label).toBe('Test Area, Test City');
    TestBed.tick();
    expect(JSON.parse(localStorage.getItem('bb_delivery_location')!).label).toBe('Test Area, Test City');
  });

  it('labels a saved address by area and city', () => {
    setup();
    service.chooseAddress({
      id: 'a1',
      line1: '12 Park St',
      area: 'Sample Area',
      city: 'Sample City',
      location: { type: 'Point', coordinates: [21.5, 11.5] },
    } as DeliveryAddress);
    expect(service.location()).toEqual(expect.objectContaining({ label: 'Sample Area, Sample City', latitude: 11.5, longitude: 21.5, addressId: 'a1' }));
  });

  it('restores a saved choice after the first render and ignores corrupted data', () => {
    localStorage.setItem('bb_delivery_location', JSON.stringify({ label: 'Sample Area, Sample City', latitude: 11.5, longitude: 21.5, source: 'search' }));
    setup();
    expect(service.location()).toBeNull(); // matches server-rendered HTML
    render();
    expect(service.location()?.label).toBe('Sample Area, Sample City');

    TestBed.resetTestingModule();
    localStorage.setItem('bb_delivery_location', JSON.stringify({ label: 'x', latitude: 999, longitude: 0 }));
    setup();
    render();
    expect(service.location()).toBeNull();
  });

  it('extracts structured address fields from a reverse-geocoded place', () => {
    const extracted = extractAddressFromPlace({
      label: 'Topsia, Kolkata',
      displayName: 'Haute Street Building, 86A, Topsia Rd S, Seal Lane, Topsia, Kolkata, West Bengal, 700046, India',
      latitude: 22.54,
      longitude: 88.39,
      area: 'Topsia',
      city: 'Kolkata',
      state: 'West Bengal',
      postalCode: '700046',
    });
    expect(extracted.line1).toBe('Haute Street Building, 86A, Topsia Rd S, Seal Lane, Topsia');
    expect(extracted.line2).toBe('86A');
    expect(extracted.area).toBe('Topsia');
    expect(extracted.city).toBe('Kolkata');
    expect(extracted.state).toBe('West Bengal');
    expect(extracted.postalCode).toBe('700046');
  });
});
