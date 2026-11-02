import { TestBed } from '@angular/core/testing';
import { GeolocationService, ImpreciseLocationError, MAX_USABLE_ACCURACY_M } from './geolocation.service';

describe('GeolocationService.currentPrecise', () => {
  let service: GeolocationService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(GeolocationService);
  });

  it('returns precise readings (e.g. phone GPS)', async () => {
    vi.spyOn(service, 'current').mockResolvedValue({ latitude: 10.5, longitude: 20.5, accuracy: 25 });
    await expect(service.currentPrecise()).resolves.toEqual({ latitude: 10.5, longitude: 20.5, accuracy: 25 });
  });

  it('rejects vague readings (e.g. desktop IP-based guesses) instead of showing a wrong place', async () => {
    vi.spyOn(service, 'current').mockResolvedValue({ latitude: 10.5, longitude: 20.5, accuracy: MAX_USABLE_ACCURACY_M + 1 });
    await expect(service.currentPrecise()).rejects.toBeInstanceOf(ImpreciseLocationError);
  });
});
