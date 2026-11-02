import { DestroyRef, Signal, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { EMPTY, distinctUntilChanged, interval, switchMap } from 'rxjs';
import { RealtimeService, RiderLocation } from '../../../core/services/realtime.service';
import { Point, RoadRoute, RoutingService, fromCoordinates } from '../../../core/services/routing.service';
import { Order, OrderStatus } from '../../models/checkout.models';

/** A position older than this is shown as stale ("last seen 3 min ago"). */
export const STALE_AFTER_MS = 90_000;
/** Re-estimate the rider's remaining route after they move this far... */
const REROUTE_AFTER_M = 250;
/** ...or this long has passed. */
const REROUTE_AFTER_MS = 60_000;

const WATCHABLE: OrderStatus[] = ['ready_for_pickup', 'assigned', 'picked_up', 'on_the_way'];

const metres = (a: Point, b: Point) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.latitude - a.latitude) / 2) ** 2 + Math.cos(r(a.latitude)) * Math.cos(r(b.latitude)) * Math.sin(r(b.longitude - a.longitude) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
};

type TrackableOrder = Pick<Order, 'id' | 'status' | 'restaurantSnapshot'> & { deliveryAddress: { location?: { coordinates: [number, number] } } };

/**
 * Live tracking state for one order, shared by the customer and admin views:
 * the rider's latest position (and whether it is stale), the planned road
 * route, and a road-based estimate of the rider's remaining trip.
 * Create in an injection context (component constructor).
 */
export function deliveryTracking(order: Signal<TrackableOrder | null>) {
  const realtime = inject(RealtimeService);
  const routing = inject(RoutingService);
  const destroyRef = inject(DestroyRef);

  const restaurant = computed(() => fromCoordinates(order()?.restaurantSnapshot.location?.coordinates));
  const destination = computed(() => fromCoordinates(order()?.deliveryAddress.location?.coordinates));
  const status = computed(() => order()?.status ?? null);
  /** Heading to the restaurant (assigned) or to the customer (picked up / on the way). */
  const target = computed(() => (status() === 'assigned' ? restaurant() : destination()));

  const rider = signal<RiderLocation | null>(null);
  const now = signal(Date.now());
  interval(5000)
    .pipe(takeUntilDestroyed(destroyRef))
    .subscribe(() => now.set(Date.now()));

  // Watch live while the order can have a rider; re-join when it moves into that stage.
  const watchKey = computed(() => {
    const o = order();
    return o && WATCHABLE.includes(o.status) ? o.id : null;
  });
  toObservable(watchKey)
    .pipe(
      distinctUntilChanged(),
      switchMap((id) => (id ? realtime.track(id) : EMPTY)),
      takeUntilDestroyed(destroyRef),
    )
    .subscribe((location) => rider.set(location));

  /** Planned road route restaurant -> customer (drawn on the map). */
  const plannedRoute = signal<RoadRoute | null>(null);
  toObservable(computed(() => {
    const a = restaurant();
    const b = destination();
    return a && b ? `${a.latitude},${a.longitude},${b.latitude},${b.longitude}` : null;
  }))
    .pipe(
      distinctUntilChanged(),
      switchMap(() => {
        const a = restaurant();
        const b = destination();
        return a && b ? routing.route(a, b) : EMPTY;
      }),
      takeUntilDestroyed(destroyRef),
    )
    .subscribe((r) => plannedRoute.set(r));

  /** Remaining trip from the rider's position to their next stop (estimate). */
  const remaining = signal<RoadRoute | null>(null);
  let routedFrom: { point: Point; at: number; target: string } | null = null;
  const riderPoint = computed<Point | null>(() => {
    const r = rider();
    return r && ['assigned', 'picked_up', 'on_the_way'].includes(status() ?? '') ? { latitude: r.latitude, longitude: r.longitude } : null;
  });
  toObservable(computed(() => ({ from: riderPoint(), to: target() })))
    .pipe(
      switchMap(({ from, to }) => {
        if (!from || !to) {
          remaining.set(null);
          return EMPTY;
        }
        const targetKey = `${to.latitude},${to.longitude}`;
        const fresh = routedFrom && routedFrom.target === targetKey && metres(routedFrom.point, from) < REROUTE_AFTER_M && Date.now() - routedFrom.at < REROUTE_AFTER_MS;
        if (fresh) return EMPTY;
        routedFrom = { point: from, at: Date.now(), target: targetKey };
        return routing.route(from, to);
      }),
      takeUntilDestroyed(destroyRef),
    )
    .subscribe((r) => remaining.set(r));

  const riderStale = computed(() => {
    const r = rider();
    return !!r && now() - new Date(r.at).getTime() > STALE_AFTER_MS;
  });
  const riderSeenSeconds = computed(() => {
    const r = rider();
    return r ? Math.max(0, Math.round((now() - new Date(r.at).getTime()) / 1000)) : null;
  });
  /** Straight-line distance from the rider to their next stop (used when no road route is available). */
  const straightLineToTarget = computed(() => {
    const from = riderPoint();
    const to = target();
    return from && to ? metres(from, to) : null;
  });

  return { restaurant, destination, target, rider: riderPoint, riderStale, riderSeenSeconds, plannedRoute, remaining, straightLineToTarget };
}

export type DeliveryTracking = ReturnType<typeof deliveryTracking>;
