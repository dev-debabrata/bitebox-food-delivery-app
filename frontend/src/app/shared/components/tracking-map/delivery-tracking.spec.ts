import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { EMPTY, Subject, of } from 'rxjs';
import { OrderTrackingService } from '../../../core/services/order-tracking.service';
import { RealtimeService, RiderLocation } from '../../../core/services/realtime.service';
import { RoutingService } from '../../../core/services/routing.service';
import { deliveryTracking } from './delivery-tracking';

describe('deliveryTracking', () => {
  const live = new Subject<RiderLocation>();
  const get = vi.fn();
  const order = signal({
    id: 'o1',
    status: 'on_the_way' as const,
    restaurantSnapshot: {
      name: 'Test Kitchen',
      location: { type: 'Point', coordinates: [77.64, 12.97] },
    },
    deliveryAddress: { location: { coordinates: [77.62, 12.93] as [number, number] } },
  });
  const at = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString();
  const flush = () => new Promise((r) => setTimeout(r));

  function create() {
    TestBed.configureTestingModule({
      providers: [
        { provide: RealtimeService, useValue: { connected: signal(true), track: () => live } },
        { provide: OrderTrackingService, useValue: { get } },
        { provide: RoutingService, useValue: { route: () => EMPTY } },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return TestBed.runInInjectionContext(() => deliveryTracking(order as any));
  }

  beforeEach(() => get.mockReset());

  it('restores the position and trail over REST, then extends the trail with live points', async () => {
    get.mockReturnValue(
      of({
        orderId: 'o1',
        status: 'on_the_way',
        tracking: true,
        lastPoint: { latitude: 12.96, longitude: 77.635, accuracy: 10, at: at(-20) },
        ageSeconds: 20,
        stale: false,
        recentPath: [
          [12.97, 77.64],
          [12.965, 77.638],
          [12.96, 77.635],
        ],
      }),
    );
    const t = create();
    TestBed.tick();
    await flush();
    TestBed.tick();
    expect(get).toHaveBeenCalledWith('o1');
    expect(t.rider()).toEqual({ latitude: 12.96, longitude: 77.635 });
    expect(t.trail().length).toBe(3);

    // ~5 m away: too close to add; ~600 m away: added.
    live.next({ orderId: 'o1', latitude: 12.96004, longitude: 77.635, accuracy: 8, at: at(0) });
    expect(t.trail().length).toBe(3);
    live.next({ orderId: 'o1', latitude: 12.955, longitude: 77.632, accuracy: 8, at: at(5) });
    expect(t.trail().length).toBe(4);
    expect(t.rider()).toEqual({ latitude: 12.955, longitude: 77.632 });

    // An older fix (e.g. a late REST answer) never moves the rider back.
    live.next({ orderId: 'o1', latitude: 12.97, longitude: 77.64, accuracy: 8, at: at(-60) });
    expect(t.rider()).toEqual({ latitude: 12.955, longitude: 77.632 });
  });

  it('works without the tracking endpoint', async () => {
    get.mockReturnValue(of(null));
    const t = create();
    TestBed.tick();
    await flush();
    expect(t.trail()).toEqual([]);
    live.next({ orderId: 'o1', latitude: 12.955, longitude: 77.632, accuracy: 8, at: at(0) });
    expect(t.rider()).toEqual({ latitude: 12.955, longitude: 77.632 });
    expect(t.trail().length).toBe(1);
  });
});
