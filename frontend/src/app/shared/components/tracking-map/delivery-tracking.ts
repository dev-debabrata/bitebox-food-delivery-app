import { DestroyRef, Signal, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { EMPTY, distinctUntilChanged, interval, switchMap } from 'rxjs';
import { RealtimeService, RiderLocation } from '../../../core/services/realtime.service';
import {
  Point,
  RoadRoute,
  RoutingService,
  distanceMeters,
  fromCoordinates,
} from '../../../core/services/routing.service';
import { Order, OrderStatus } from '../../models/checkout.models';
import { AT_OR_TO_RESTAURANT, TRACKED_STATUSES } from '../../models/order-management.models';

/** A position older than this is shown as stale ("last seen 3 min ago"). */
export const STALE_AFTER_MS = 90_000;
/** Re-estimate a moving rider's road route after this distance... */
const REROUTE_AFTER_M = 250;
/** ...or this long. */
const REROUTE_AFTER_MS = 60_000;

/** Statuses in which an order can gain a rider worth watching live. */
const WATCHABLE: OrderStatus[] = ['ready_for_pickup', ...TRACKED_STATUSES];

const pointKey = (p: Point) => `${p.latitude},${p.longitude}`;

/**
 * Road route from a moving point to a target, re-estimated only when the start
 * has moved REROUTE_AFTER_M, REROUTE_AFTER_MS has passed, or the target changed
 * (keeps load on the free routing provider low). Null when either end is unknown
 * or routing is unavailable. Call in an injection context.
 */
export function rerouteWhileMoving(
  from: Signal<Point | null>,
  to: Signal<Point | null>,
): Signal<RoadRoute | null> {
  const routing = inject(RoutingService);
  const route = signal<RoadRoute | null>(null);
  let last: { point: Point; at: number; target: string } | null = null;
  toObservable(computed(() => ({ from: from(), to: to() })))
    .pipe(
      switchMap(({ from: start, to: target }) => {
        if (!start || !target) {
          route.set(null);
          last = null;
          return EMPTY;
        }
        const key = pointKey(target);
        if (
          last &&
          last.target === key &&
          Date.now() - last.at < REROUTE_AFTER_MS &&
          distanceMeters(last.point, start) < REROUTE_AFTER_M
        ) {
          return EMPTY;
        }
        last = { point: start, at: Date.now(), target: key };
        return routing.route(start, target);
      }),
      takeUntilDestroyed(inject(DestroyRef)),
    )
    .subscribe((r) => route.set(r));
  return route.asReadonly();
}

type TrackableOrder = Pick<Order, 'id' | 'status' | 'restaurantSnapshot'> & {
  deliveryAddress: { location?: { coordinates: [number, number] } };
};

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

  const restaurant = computed(() =>
    fromCoordinates(order()?.restaurantSnapshot.location?.coordinates),
  );
  const destination = computed(() =>
    fromCoordinates(order()?.deliveryAddress.location?.coordinates),
  );
  const status = computed(() => order()?.status ?? null);
  /** Heading to the restaurant (assigned) or to the customer (picked up / on the way). */
  const target = computed(() =>
    AT_OR_TO_RESTAURANT.includes(status() as OrderStatus) ? restaurant() : destination(),
  );

  const location = signal<RiderLocation | null>(null);
  // Watch live while the order can have a rider; re-join when it moves into that stage.
  toObservable(
    computed(() => (order() && WATCHABLE.includes(order()!.status) ? order()!.id : null)),
  )
    .pipe(
      distinctUntilChanged(),
      switchMap((id) => (id ? realtime.track(id) : EMPTY)),
      takeUntilDestroyed(destroyRef),
    )
    .subscribe((l) => location.set(l));

  const rider = computed<Point | null>(() => {
    const l = location();
    return l && TRACKED_STATUSES.includes(status() as OrderStatus)
      ? { latitude: l.latitude, longitude: l.longitude }
      : null;
  });

  // "Updated 12s ago" / stale: a clock that only ticks while there is a rider position to age.
  const now = signal(Date.now());
  toObservable(computed(() => rider() !== null))
    .pipe(
      switchMap((tracking) => (tracking ? interval(5000) : EMPTY)),
      takeUntilDestroyed(destroyRef),
    )
    .subscribe(() => now.set(Date.now()));
  const riderSeenSeconds = computed(() => {
    const l = location();
    return l && rider() ? Math.max(0, Math.round((now() - new Date(l.at).getTime()) / 1000)) : null;
  });
  const riderStale = computed(() => (riderSeenSeconds() ?? 0) * 1000 > STALE_AFTER_MS);

  /** Planned road route restaurant -> customer (drawn on the map). */
  const plannedRoute = signal<RoadRoute | null>(null);
  toObservable(
    computed(() =>
      restaurant() && destination()
        ? `${pointKey(restaurant()!)}>${pointKey(destination()!)}`
        : null,
    ),
  )
    .pipe(
      distinctUntilChanged(),
      switchMap((key) => (key ? routing.route(restaurant()!, destination()!) : EMPTY)),
      takeUntilDestroyed(destroyRef),
    )
    .subscribe((r) => plannedRoute.set(r));

  /** Remaining trip from the rider's position to their next stop (estimate). */
  const remaining = rerouteWhileMoving(rider, target);
  /** Straight-line distance from the rider to their next stop (used when no road route is available). */
  const straightLineToTarget = computed(() =>
    rider() && target() ? distanceMeters(rider()!, target()!) : null,
  );

  return {
    restaurant,
    destination,
    target,
    rider,
    riderStale,
    riderSeenSeconds,
    plannedRoute,
    remaining,
    straightLineToTarget,
  };
}
