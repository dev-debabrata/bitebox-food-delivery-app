import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { RiderService } from './order-management.service';
import { RealtimeService } from './realtime.service';
import { RiderGps } from './rider-gps.service';
import { isValidPoint } from './routing.service';

describe('isValidPoint', () => {
  it('rejects missing, out-of-range and 0,0 coordinates', () => {
    expect(isValidPoint({ latitude: 12.97, longitude: 77.64 })).toBe(true);
    expect(isValidPoint(null)).toBe(false);
    expect(isValidPoint({ latitude: 91, longitude: 0 })).toBe(false);
    expect(isValidPoint({ latitude: NaN, longitude: 1 })).toBe(false);
    expect(isValidPoint({ latitude: 0, longitude: 0 })).toBe(false);
  });
});

describe('RiderGps', () => {
  let onPosition: (p: GeolocationPosition) => void;
  let onError: (e: GeolocationPositionError) => void;
  const send = vi.fn();
  let gps: RiderGps;
  let now = 1_000_000;

  // ~111 m per 0.001 degree of latitude.
  const fix = (lat: number, accuracy = 10) =>
    onPosition({ coords: { latitude: lat, longitude: 77.64, accuracy } } as GeolocationPosition);
  const flush = () => new Promise((r) => setTimeout(r));

  beforeEach(() => {
    send.mockReset().mockResolvedValue({ ok: true });
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition: (ok: typeof onPosition, err: typeof onError) => {
          onPosition = ok;
          onError = err;
          return 1;
        },
        clearWatch: vi.fn(),
      },
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: RealtimeService, useValue: { sendRiderLocation: send } },
        { provide: RiderService, useValue: { reportLocation: () => of(undefined) } },
      ],
    });
    gps = TestBed.inject(RiderGps);
  });

  afterEach(() => {
    gps.stop();
    vi.restoreAllMocks();
  });

  it('shares often during a delivery, but not faster than every few seconds', async () => {
    gps.update(true, true);
    fix(12.97);
    await flush();
    expect(send).toHaveBeenCalledTimes(1); // first fix goes out at once

    now += 1000;
    fix(12.9705); // moved ~55 m, but only 1 s later
    await flush();
    expect(send).toHaveBeenCalledTimes(1);

    now += 4000;
    fix(12.971); // 5 s and ~111 m since the last update
    await flush();
    expect(send).toHaveBeenCalledTimes(2);

    now += 5000;
    fix(12.971); // standing still: wait for the 15 s heartbeat
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    now += 11000;
    fix(12.971);
    await flush();
    expect(send).toHaveBeenCalledTimes(3);
    expect(gps.lastSharedAt()).toBe(now);
  });

  it('shares rarely when idle', async () => {
    gps.update(true, false);
    fix(12.97);
    await flush();
    now += 30_000;
    fix(12.98);
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    now += 31_000;
    fix(12.98);
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('never shares imprecise readings and explains problems', async () => {
    gps.update(true, true);
    fix(12.97, 5000);
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(gps.problem()).toContain('GPS signal is weak');

    onError({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError);
    expect(gps.problem()).toContain('permission is off');
  });
});
