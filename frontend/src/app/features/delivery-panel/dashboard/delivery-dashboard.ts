import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { FormRoot, TreeValidationResult, form, required } from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { IconComponent, SelectOption, ToggleComponent } from 'nexprime';
import { EMPTY, catchError, firstValueFrom, interval, of, switchMap } from 'rxjs';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import {
  GeolocationService,
  ImpreciseLocationError,
} from '../../../core/services/geolocation.service';
import { NotificationService } from '../../../core/services/notification.service';
import { RiderService } from '../../../core/services/order-management.service';
import { liveRefresh } from '../../../core/services/poll';
import { RiderGps } from '../../../core/services/rider-gps.service';
import { Point, etaMinutes, fromCoordinates } from '../../../core/services/routing.service';
import { rerouteWhileMoving } from '../../../shared/components/tracking-map/delivery-tracking';
import { TrackingMap } from '../../../shared/components/tracking-map/tracking-map';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { OrderStatusChip } from '../../../shared/components/order-status-chip/order-status-chip';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { serverErrors, shownError } from '../../../shared/forms/form-errors';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { VEHICLE_LABEL, VehicleType } from '../../../shared/models/checkout.models';
import {
  RiderAction,
  RiderDashboard,
  RiderOrder,
} from '../../../shared/models/order-management.models';
import { ItemCountPipe } from '../../../shared/pipes/item-count.pipe';
import { InrPipe, formatDistance } from '../../../shared/pipes/money.pipes';

const POLL_MS = 30_000;

const NEXT_STEP: Partial<
  Record<RiderOrder['status'], { action: RiderAction; label: string; hint: string; icon: string }>
> = {
  assigned: {
    action: 'picked_up',
    label: 'Picked up',
    hint: 'Go to the restaurant and collect the order.',
    icon: 'inventory_2',
  },
  picked_up: {
    action: 'on_the_way',
    label: 'Start delivery',
    hint: 'Order collected. Head to the customer.',
    icon: 'two_wheeler',
  },
  on_the_way: {
    action: 'delivered',
    label: 'Delivered',
    hint: 'Hand over the order and collect the cash.',
    icon: 'task_alt',
  },
};

@Component({
  selector: 'bb-delivery-dashboard',
  imports: [
    DecimalPipe,
    FormRoot,
    NP_FORM_FIELDS,
    RouterLink,
    MatButtonModule,
    IconComponent,
    NpIconPipe,
    MatProgressBarModule,
    ToggleComponent,
    EmptyState,
    OrderStatusChip,
    PageHeader,
    InrPipe,
    ItemCountPipe,
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
  protected readonly gps = inject(RiderGps);

  protected readonly data = signal<RiderDashboard | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly switching = signal(false);
  protected readonly acting = signal(false);
  protected readonly availabilityError = signal<string | null>(null);
  protected readonly now = signal(Date.now());

  protected readonly profile = computed(() => this.data()?.profile ?? null);
  protected readonly online = computed(() => this.profile()?.isOnline ?? false);
  protected readonly onlineSwitch = linkedSignal(() => this.online());
  protected readonly offer = computed(() => this.data()?.offer ?? null);
  protected readonly active = computed(() => this.data()?.activeOrder ?? null);
  protected readonly nextStep = computed(() => {
    const o = this.active();
    if (!o?.status) return null;
    const step = NEXT_STEP[o.status];
    if (!step) return null;
    if (o.status === 'on_the_way') {
      const isPaid = o.paymentMethod === 'online' || o.paymentStatus === 'paid';
      return {
        ...step,
        hint: isPaid
          ? 'Hand over the order to the customer (already paid online).'
          : 'Hand over the order and collect the cash.',
      };
    }
    return step;
  });
  protected readonly vehicleLabel = VEHICLE_LABEL;

  protected readonly stops = computed(() => {
    const o = this.active();
    if (!o) return null;
    const restaurant = fromCoordinates(o.restaurantSnapshot.location?.coordinates);
    const destination = fromCoordinates(o.deliveryAddress.location?.coordinates);
    return {
      restaurant,
      destination,
      target: o.status === 'assigned' ? restaurant : destination,
      toRestaurant: o.status === 'assigned',
    };
  });
  protected readonly directionsUrl = computed(() => {
    const t = this.stops()?.target;
    return t
      ? `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=;${t.latitude},${t.longitude}`
      : null;
  });
  protected readonly myPosition = computed<Point | null>(() => {
    const fix = this.gps.fix();
    return fix && fix.accuracy <= 1000
      ? { latitude: fix.latitude, longitude: fix.longitude }
      : null;
  });
  protected readonly routeToStop = rerouteWhileMoving(
    this.myPosition,
    computed(() => this.stops()?.target ?? null),
  );
  protected readonly minutes = etaMinutes;

  protected readonly offerSecondsLeft = computed(() => {
    const expires = this.offer()?.offerExpiresAt;
    return expires ? Math.max(0, Math.ceil((new Date(expires).getTime() - this.now()) / 1000)) : 0;
  });
  protected readonly offerProgress = computed(
    () => (this.offerSecondsLeft() / (this.offer()?.offerWindowSeconds ?? 90)) * 100,
  );

  protected readonly vehicleOptions: SelectOption[] = (
    Object.keys(VEHICLE_LABEL) as VehicleType[]
  ).map((v) => ({
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
    liveRefresh(reload, { pollMs: POLL_MS, debounceMs: 200 })
      .pipe(takeUntilDestroyed())
      .subscribe((d) => d && this.apply(d));

    toObservable(computed(() => this.offer() !== null))
      .pipe(
        switchMap((offered) => (offered ? interval(1000) : EMPTY)),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.now.set(Date.now()));

    effect(() => {
      const online = this.online();
      const delivering = !!this.active();
      untracked(() => this.gps.update(online, delivering));
    });

    inject(DestroyRef).onDestroy(() => this.gps.stop());
  }

  private apply(d: RiderDashboard): void {
    const previousOffer = this.offer()?.id;
    this.loadError.set(null);
    this.data.set(d);
    if (d.offer && d.offer.id !== previousOffer) {
      this.now.set(Date.now());
      this.notify.info(`New delivery request from ${d.offer.restaurantSnapshot.name}`);
    }
    if (!d.profile.vehicleType && !this.editingVehicle()) this.editingVehicle.set(true);
  }

  protected editVehicle(): void {
    const p = this.profile();
    this.vehicleForm().reset({
      vehicleType: p?.vehicleType ?? '',
      vehicleNumber: p?.vehicleNumber ?? '',
    });
    this.editingVehicle.set(true);
  }

  private async saveVehicle(): Promise<TreeValidationResult> {
    const { vehicleType, vehicleNumber } = this.vehicleModel();
    try {
      const profile = await firstValueFrom(
        this.rider.saveVehicle(vehicleType as VehicleType, vehicleNumber.trim()),
      );
      this.data.update((d) => (d ? { ...d, profile } : d));
      this.editingVehicle.set(false);
      this.notify.success('Vehicle saved');
      return undefined;
    } catch (err) {
      // Field errors (422) show under their fields; anything else as a message.
      const details = fieldErrors(err);
      if (!details.length) this.notify.error(errorMessage(err));
      return serverErrors(this.vehicleForm, details);
    }
  }

  protected async setOnline(online: boolean): Promise<void> {
    this.onlineSwitch.set(online);
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
      this.onlineSwitch.set(this.online());
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
    if (step)
      this.act(
        this.rider.setStatus(order.id, step.action),
        step.action === 'delivered' ? 'Delivered. Nice work!' : step.label,
      );
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
}
