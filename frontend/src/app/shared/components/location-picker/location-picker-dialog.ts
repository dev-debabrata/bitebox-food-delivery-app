import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import { IconComponent } from 'nexprime';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Subscription, firstValueFrom } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { AddressService } from '../../../core/services/checkout-api.service';
import {
  DeliveryLocation,
  DeliveryLocationService,
  Place,
} from '../../../core/services/delivery-location.service';
import {
  GeolocationService,
  ImpreciseLocationError,
} from '../../../core/services/geolocation.service';
import { DeliveryAddress } from '../../models/checkout.models';
import { LatLng, MapPicker } from '../map-picker/map-picker';
import { PlaceSearch } from '../place-search/place-search';

/** A point waiting for the user to confirm it on the map. */
interface Candidate {
  latitude: number;
  longitude: number;
  label: string;
  detail?: string;
  source: DeliveryLocation['source'];
}

/**
 * "Where should we deliver?"
 * - "Use my current location" detects, names and saves the location in one click.
 * - Search results open the map step so the pin can be fine-tuned.
 * - Saved addresses are applied directly.
 */
@Component({
  selector: 'bb-location-picker-dialog',
  imports: [
    PlaceSearch,
    MatDialogModule,
    MatButtonModule,
    IconComponent, NpIconPipe,
    MatProgressBarModule,
    MapPicker,
  ],
  templateUrl: './location-picker-dialog.html',
  styleUrl: './location-picker-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LocationPickerDialog {
  protected readonly location = inject(DeliveryLocationService);
  protected readonly geo = inject(GeolocationService);
  private readonly ref = inject(MatDialogRef<LocationPickerDialog>);
  private readonly auth = inject(AuthService);

  private readonly placeSearch = viewChild(PlaceSearch);
  protected readonly locating = signal(false);
  protected readonly gpsError = signal<string | null>(null);
  protected readonly addresses = signal<DeliveryAddress[]>([]);
  protected readonly isCustomer = computed(() => this.auth.role() === 'customer');

  /** Step 2 state. */
  protected readonly candidate = signal<Candidate | null>(null);
  protected readonly naming = signal(false);
  private naming$?: Subscription;

  constructor() {
    if (this.isCustomer()) {
      inject(AddressService)
        .list()
        .subscribe({ next: (list) => this.addresses.set(list), error: () => undefined });
    }
  }

  /** Detects, names and saves the current location in one step. */
  protected async useGps(): Promise<void> {
    this.locating.set(true);
    this.gpsError.set(null);
    try {
      const { latitude, longitude } = await this.geo.currentPrecise();
      let label = 'Current location';
      let detail: string | undefined;
      try {
        const place = await firstValueFrom(this.location.reverse(latitude, longitude));
        label = place.label || label;
        detail = place.displayName;
      } catch {
        detail = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
      }
      this.location.choosePoint({ latitude, longitude, label, detail, source: 'gps' });
      this.ref.close(true);
    } catch (err) {
      // Never use a vague reading: it would show a place the customer is not at.
      this.gpsError.set(
        err instanceof ImpreciseLocationError
          ? err.message
          : `${(err as Error).message} Search for your area instead.`,
      );
      this.placeSearch()?.focus();
    } finally {
      this.locating.set(false);
    }
  }

  protected pick(place: Place): void {
    this.candidate.set({
      latitude: place.latitude,
      longitude: place.longitude,
      label: place.label,
      detail: place.displayName,
      source: 'search',
    });
  }

  /** Dragging the pin / tapping the map: that exact point, renamed. */
  protected onPinMoved(point: LatLng): void {
    this.candidate.update((c) => (c ? { ...c, ...point } : c));
    this.name(point);
  }

  protected back(): void {
    this.candidate.set(null);
  }

  protected confirm(): void {
    const c = this.candidate();
    if (!c) return;
    this.location.choosePoint({
      latitude: c.latitude,
      longitude: c.longitude,
      label: c.label,
      detail: c.detail,
      source: c.source,
    });
    this.ref.close(true);
  }

  protected pickAddress(address: DeliveryAddress): void {
    this.location.chooseAddress(address);
    this.ref.close(true);
  }

  protected clear(): void {
    this.location.clear();
    this.ref.close(true);
  }

  /** Reverse-geocodes the candidate point to a readable name. */
  private name(point: LatLng): void {
    this.naming$?.unsubscribe();
    this.naming.set(true);
    this.naming$ = this.location.reverse(point.latitude, point.longitude).subscribe({
      next: (place) => {
        this.candidate.update((c) =>
          c ? { ...c, label: place.label || c.label, detail: place.displayName } : c,
        );
        this.naming.set(false);
      },
      error: () => {
        this.candidate.update((c) =>
          c ? { ...c, detail: `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}` } : c,
        );
        this.naming.set(false);
      },
    });
  }
}
