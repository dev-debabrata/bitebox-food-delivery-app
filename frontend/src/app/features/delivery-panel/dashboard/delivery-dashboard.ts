import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { FormRoot, form, required } from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { SelectOption, ToggleComponent } from 'nexprime';
import { EMPTY, catchError, debounceTime, firstValueFrom, interval, merge, of, switchMap } from 'rxjs';
import { errorMessage } from '../../../core/services/api-error';
import { GeolocationService, ImpreciseLocationError } from '../../../core/services/geolocation.service';
import { NotificationService } from '../../../core/services/notification.service';
import { RiderService } from '../../../core/services/order-management.service';
import { pollWhileVisible } from '../../../core/services/poll';
import { RealtimeService } from '../../../core/services/realtime.service';
import { RiderGps } from '../../../core/services/rider-gps.service';
import { Point, RoadRoute, RoutingService, fromCoordinates } from '../../../core/services/routing.service';
import { TrackingMap } from '../../../shared/components/tracking-map/tracking-map';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { OrderStatusChip } from '../../../shared/components/order-status-chip/order-status-chip';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { shownError } from '../../../shared/forms/form-errors';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { VEHICLE_LABEL, VehicleType } from '../../../shared/models/checkout.models';
import { RiderAction, RiderDashboard, RiderOrder } from '../../../shared/models/order-management.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';

/** Fallback refresh; offers and status changes normally arrive live over Socket.IO. */
const POLL_MS = 30_000;

/** The next step on an active delivery, and what the rider should do before pressing it. */
const NEXT_STEP: Partial<Record<RiderOrder['status'], { action: RiderAction; label: string; hint: string; icon: string }>> = {
  assigned: { action: 'picked_up', label: 'Picked up', hint: 'Go to the restaurant and collect the order.', icon: 'inventory_2' },
  picked_up: { action: 'on_the_way', label: 'Start delivery', hint: 'Order collected. Head to the customer.', icon: 'two_wheeler' },
  on_the_way: { action: 'delivered', label: 'Delivered', hint: 'Hand over the order and collect the cash.', icon: 'task_alt' },
};

/** The rider's home: availability, the request on offer, and the delivery in progress. */
@Component({
  selector: 'bb-delivery-dashboard',
  imports: [
    DecimalPipe,
    FormRoot,
    NP_FORM_FIELDS,
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    ToggleComponent,
    EmptyState,
    OrderStatusChip,
    PageHeader,
    InrPipe,
    TrackingMap,
  ],
  templateUrl: './delivery-dashboard.html',
  styleUrl: './delivery-dashboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeliveryDashboard {
  private readonly rider = inject(RiderService);
  private readonly geo = inject(GeolocationService);
  private readonly notify = inject(NotificationService);
  private readonly routing = inject(RoutingService);
  /** Device GPS, shared with the server while online (frequently during a delivery). */
  protected readonly gps = inject(RiderGps);

  protected readonly data = signal<RiderDashboard | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly switching = signal(false);
  protected readonly acting = signal(false);
  protected readonly availabilityError = signal<string | null>(null);
  /** Ticks every second for the offer countdown. */
  protected readonly now = signal(Date.now());

  protected readonly profile = computed(() => this.data()?.profile ?? null);
  protected readonly online = computed(() => this.profile()?.isOnline ?? false);
  protected readonly offer = computed(() => this.data()?.offer ?? null);
  protected readonly active = computed(() => this.data()?.activeOrder ?? null);
  protected readonly nextStep = computed(() => {
    const status = this.active()?.status;
    return status ? (NEXT_STEP[status] ?? null) : null;
  });
  protected readonly vehicleLabel = VEHICLE_LABEL;

  // Map of the active delivery: our position and the road route to the next stop.
  protected readonly stops = computed(() => {
    const o = this.active();
    if (!o) return null;
    const restaurant = fromCoordinates(o.restaurantSnapshot.location?.coordinates);
    const destination = fromCoordinates(o.deliveryAddress.location?.coordinates);
    return { restaurant, destination, target: o.status === 'assigned' ? restaurant : destination, toRestaurant: o.status === 'assigned' };
  });
  protected readonly myPosition = computed<Point | null>(() => {
    const fix = this.gps.fix();
    return fix && fix.accuracy <= 1000 ? { latitude: fix.latitude, longitude: fix.longitude } : null;
  });
  protected readonly routeToStop = signal<RoadRoute | null>(null);
  private routedFrom: { point: Point; at: number; target: string } | null = null;
  protected readonly minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

  /** Seconds left on the offer, and as a share of the full window (for the bar). */
  protected readonly offerSecondsLeft = computed(() => {
    const expires = this.offer()?.offerExpiresAt;
    return expires ? Math.max(0, Math.ceil((new Date(expires).getTime() - this.now()) / 1000)) : 0;
  });
  private offerWindow = 90;
  protected readonly offerProgress = computed(() => (this.offerSecondsLeft() / this.offerWindow) * 100);

  // Vehicle (first-time setup and edits) -------------------------------------
  protected readonly vehicleOptions: SelectOption[] = (Object.keys(VEHICLE_LABEL) as VehicleType[]).map((v) => ({
    value: v,
    label: VEHICLE_LABEL[v],
  }));
  protected readonly editingVehicle = signal(false);
  protected readonly vehicleModel = signal({ vehicleType: '', vehicleNumber: '' });
  protected readonly vehicleForm = form(
    this.vehicleModel,
    (path) => required(path.vehicleType, { message: 'Choose your vehicle' }),
    { submission: { action: () => this.saveVehicle() } },
  );
  protected readonly shownError = shownError;

  constructor() {
    const reload = () =>
      this.rider.dashboard().pipe(
        catchError((err: unknown) => {
          this.loadError.set(errorMessage(err, 'Could not load your dashboard.'));
          return of(null);
        }),
      );
    merge(
      // A new offer, a withdrawn one, or a change to the order we carry.
      inject(RealtimeService).orderUpdates$.pipe(debounceTime(200), switchMap(reload)),
      pollWhileVisible(reload, POLL_MS),
    )
      .pipe(takeUntilDestroyed())
      .subscribe((d) => d && this.apply(d));

    interval(1000)
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.now.set(Date.now()));

    // GPS: watch while online; share often during a delivery, rarely when idle.
    effect(() => {
      const online = this.online();
      const delivering = !!this.active();
      untracked(() => {
        if (online) {
          this.gps.start(delivering);
          this.gps.setDelivering(delivering);
        } else {
          this.gps.stop();
        }
      });
    });

    // Re-estimate the road route to the next stop after moving ~250 m, a minute passing, or the stop changing.
    toObservable(computed(() => ({ from: this.myPosition(), to: this.stops()?.target ?? null })))
      .pipe(
        switchMap(({ from, to }) => {
          if (!from || !to) {
            this.routeToStop.set(null);
            this.routedFrom = null;
            return EMPTY;
          }
          const key = `${to.latitude},${to.longitude}`;
          const r = this.routedFrom;
          if (r && r.target === key && Date.now() - r.at < 60_000 && distance(r.point, from) < 250) return EMPTY;
          this.routedFrom = { point: from, at: Date.now(), target: key };
          return this.routing.route(from, to);
        }),
        takeUntilDestroyed(),
      )
      .subscribe((route) => this.routeToStop.set(route));

    inject(DestroyRef).onDestroy(() => this.gps.stop());
  }

  private apply(d: RiderDashboard): void {
    const previousOffer = this.offer()?.id;
    this.loadError.set(null);
    this.data.set(d);
    if (d.offer && d.offer.id !== previousOffer) {
      this.offerWindow = Math.max(1, Math.round((new Date(d.offer.offerExpiresAt!).getTime() - Date.now()) / 1000));
      this.notify.info(`New delivery request from ${d.offer.restaurantSnapshot.name}`);
    }
    if (!d.profile.vehicleType && !this.editingVehicle()) this.editingVehicle.set(true);
  }

  protected editVehicle(): void {
    const p = this.profile();
    this.vehicleForm().reset({ vehicleType: p?.vehicleType ?? '', vehicleNumber: p?.vehicleNumber ?? '' });
    this.editingVehicle.set(true);
  }

  private async saveVehicle(): Promise<undefined> {
    const { vehicleType, vehicleNumber } = this.vehicleModel();
    try {
      const profile = await firstValueFrom(this.rider.saveVehicle(vehicleType as VehicleType, vehicleNumber.trim()));
      this.data.update((d) => (d ? { ...d, profile } : d));
      this.editingVehicle.set(false);
      this.notify.success('Vehicle saved');
    } catch (err) {
      this.notify.error(errorMessage(err));
    }
    return undefined;
  }

  /** Online needs a precise location (requests are offered by distance). */
  protected async setOnline(online: boolean, toggle: ToggleComponent): Promise<void> {
    // Putting the switch back after a failure also emits a change; that is not a request.
    if (online === this.online()) return;
    this.switching.set(true);
    this.availabilityError.set(null);
    try {
      if (online) {
        const { latitude, longitude } = await this.geo.currentPrecise();
        this.apply(await firstValueFrom(this.rider.goOnline(latitude, longitude)));
        this.notify.success('You are online. Requests near you will appear here.');
      } else {
        this.apply(await firstValueFrom(this.rider.goOffline()));
      }
    } catch (err) {
      this.availabilityError.set(
        err instanceof ImpreciseLocationError
          ? `This device only knows your location to within about ${formatDistance(err.accuracyMeters)}, ` +
            'which is too vague to offer you nearby orders. Turn on GPS / precise location, or use your phone.'
          : err instanceof Error // browser location errors carry a readable message
            ? err.message
            : errorMessage(err),
      );
      // The switch flipped itself when tapped; put it back to the real state.
      toggle.checked.set(this.online());
      this.rider.dashboard().subscribe({ next: (d) => this.data.set(d), error: () => undefined });
    } finally {
      this.switching.set(false);
    }
  }

  protected accept(order: RiderOrder): void {
    this.act(this.rider.accept(order.id), 'Accepted. Head to the restaurant.');
  }

  protected decline(order: RiderOrder): void {
    this.act(this.rider.decline(order.id), 'Request declined');
  }

  protected advance(order: RiderOrder): void {
    const step = NEXT_STEP[order.status];
    if (step) this.act(this.rider.setStatus(order.id, step.action), step.action === 'delivered' ? 'Delivered. Nice work!' : step.label);
  }

  private act(request: ReturnType<RiderService['accept']>, message: string): void {
    this.acting.set(true);
    request.subscribe({
      next: (d) => {
        this.acting.set(false);
        this.apply(d);
        this.notify.success(message);
      },
      error: (err: unknown) => {
        this.acting.set(false);
        this.notify.error(errorMessage(err));
        this.rider.dashboard().subscribe({ next: (d) => this.apply(d), error: () => undefined });
      },
    });
  }

  protected itemCount(order: RiderOrder): number {
    return order.items.reduce((sum, i) => sum + i.quantity, 0);
  }

  /** Turn-by-turn directions on OpenStreetMap (in-app maps arrive with live tracking). */
  protected directionsUrl(order: RiderOrder): string | null {
    const from = order.restaurantSnapshot.location?.coordinates;
    const to = order.deliveryAddress.location?.coordinates;
    if (!from || !to) return null;
    const target = order.status === 'assigned' ? from : to;
    return `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=;${target[1]},${target[0]}`;
  }
}

/** Straight-line metres between two points (only used to decide when to re-route). */
function distance(a: Point, b: Point): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.latitude - a.latitude) / 2) ** 2 + Math.cos(r(a.latitude)) * Math.cos(r(b.latitude)) * Math.sin(r(b.longitude - a.longitude) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** "800 m" / "12 km", for the imprecise-location message. */
function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${Math.round(meters / 1000)} km`;
}
