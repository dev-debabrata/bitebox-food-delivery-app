import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { FormRoot, TreeValidationResult, form, maxLength, pattern, required } from '@angular/forms/signals';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { CheckboxComponent, SearchInputComponent } from 'nexprime';
import { catchError, debounceTime, distinctUntilChanged, filter, firstValueFrom, of, switchMap, tap } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import { AddressService } from '../../../core/services/checkout-api.service';
import { DeliveryLocationService, Place } from '../../../core/services/delivery-location.service';
import { GeolocationService, ImpreciseLocationError } from '../../../core/services/geolocation.service';
import { LatLng, MapPicker } from '../map-picker/map-picker';
import { AddressInput, AddressLabel, DeliveryAddress } from '../../models/checkout.models';
import { serverErrors, shownError } from '../../forms/form-errors';
import { POSTAL_CODE_PATTERN, numberRange, phoneRules, requiredText } from '../../forms/form-rules';
import { NP_FORM_FIELDS } from '../../forms/np-form-fields';

type AutoField = 'area' | 'city' | 'state' | 'postalCode';

/**
 * Add or edit a delivery address. The location can be set by place search,
 * the browser's current location, or by dragging the pin on a map; the
 * address fields are then filled from the pinned point.
 * Closes with the saved address.
 */
@Component({
  selector: 'bb-address-form-dialog',
  imports: [
    CheckboxComponent,
    FormRoot,
    NP_FORM_FIELDS,
    MatDialogModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MapPicker,
  ],
  templateUrl: './address-form-dialog.html',
  styleUrl: './address-form-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddressFormDialog {
  protected readonly data = inject<DeliveryAddress | null>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<AddressFormDialog, DeliveryAddress>);
  private readonly service = inject(AddressService);
  protected readonly geo = inject(GeolocationService);
  private readonly places = inject(DeliveryLocationService);
  private readonly user = inject(AuthService).user;
  protected readonly shownError = shownError;

  protected readonly locating = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly locationError = signal<string | null>(null);
  /** Short description of the pinned point (from reverse geocoding). */
  protected readonly pinLabel = signal<string | null>(null);
  /** Raw coordinate inputs are tucked away unless GPS is unavailable. */
  protected readonly showCoordinates = signal(!this.geo.supported);
  protected readonly triedSave = signal(false);

  /** Text in the place search box (follows typing; set to '' to clear it). */
  protected readonly placeQuery = signal('');
  private readonly placeSearch = viewChild(SearchInputComponent, { read: ElementRef });
  protected readonly placeResults = signal<Place[]>([]);
  protected readonly searching = signal(false);

  /** Values this dialog filled in automatically; only these may be replaced when the pin moves. */
  private readonly autoFilled = new Map<AutoField, string>();

  protected readonly model = signal({
    label: (this.data?.label ?? 'home') as AddressLabel,
    recipientName: this.data?.recipientName ?? this.user()?.name ?? '',
    phone: this.data?.phone ?? this.user()?.phone ?? '',
    line1: this.data?.line1 ?? '',
    line2: this.data?.line2 ?? '',
    area: this.data?.area ?? '',
    landmark: this.data?.landmark ?? '',
    city: this.data?.city ?? '',
    state: this.data?.state ?? '',
    postalCode: this.data?.postalCode ?? '',
    latitude: this.data ? this.data.location.coordinates[1] : (null as number | null),
    longitude: this.data ? this.data.location.coordinates[0] : (null as number | null),
    isDefault: this.data?.isDefault ?? false,
  });

  protected readonly form = form(
    this.model,
    (path) => {
      requiredText(path.recipientName, 'Name', { min: 2, max: 80 });
      phoneRules(path.phone);
      requiredText(path.line1, 'Address', { min: 3, max: 120 });
      maxLength(path.line2, 120, { message: 'Keep it under 120 characters' });
      maxLength(path.area, 80, { message: 'Keep it under 80 characters' });
      maxLength(path.landmark, 80, { message: 'Keep it under 80 characters' });
      requiredText(path.city, 'City', { min: 2, max: 80 });
      requiredText(path.state, 'State', { min: 2, max: 80 });
      required(path.postalCode, { message: 'PIN code is required' });
      pattern(path.postalCode, POSTAL_CODE_PATTERN, { message: 'Enter a valid PIN code' });
      numberRange(path.latitude, 'Latitude', -90, 90);
      numberRange(path.longitude, 'Longitude', -180, 180);
    },
    { submission: { action: () => this.save() } },
  );

  protected readonly pinned = computed(() => {
    const { latitude, longitude } = this.model();
    return latitude !== null && longitude !== null && this.form.latitude().valid() && this.form.longitude().valid();
  });
  /** Shown after a save attempt without a pin (the save itself is blocked by validation). */
  protected readonly pinMissing = computed(() => this.triedSave() && !this.pinned());

  constructor() {
    toObservable(this.placeQuery)
      .pipe(
        debounceTime(500),
        distinctUntilChanged(),
        tap((q) => {
          if (q.trim().length < 3) this.placeResults.set([]);
        }),
        filter((q) => q.trim().length >= 3),
        tap(() => this.searching.set(true)),
        switchMap((q) =>
          this.places.search(q.trim()).pipe(
            catchError((err: unknown) => {
              this.locationError.set(errorMessage(err, 'Place search failed.'));
              return of([] as Place[]);
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((results) => {
        this.placeResults.set(results);
        this.searching.set(false);
      });
  }

  protected async useCurrentLocation(): Promise<void> {
    this.locating.set(true);
    this.locationError.set(null);
    this.placeResults.set([]);
    try {
      const { latitude, longitude } = await this.geo.currentPrecise();
      await this.setPin({ latitude, longitude });
    } catch (err) {
      // Never pin a vague reading: it would show a place the customer is not at.
      this.locationError.set(err instanceof ImpreciseLocationError ? err.message : `${(err as Error).message} Search for your area or tap the map instead.`);
      this.placeSearch()?.nativeElement.querySelector('input')?.focus();
    } finally {
      this.locating.set(false);
    }
  }

  protected async pickPlace(place: Place): Promise<void> {
    this.placeResults.set([]);
    this.placeQuery.set('');
    await this.setPin({ latitude: place.latitude, longitude: place.longitude });
  }

  /** The user dragged the pin or tapped the map: that is the exact spot. */
  protected async onPinMoved(point: LatLng): Promise<void> {
    await this.setPin(point);
  }

  private async setPin({ latitude, longitude }: LatLng): Promise<void> {
    this.model.update((v) => ({ ...v, latitude: +latitude.toFixed(6), longitude: +longitude.toFixed(6) }));
    await this.fillFromCoordinates(latitude, longitude);
  }

  /**
   * Fills area / city / state / PIN from the pinned point. Fields the user typed
   * are never overwritten; fields we filled earlier are updated when the pin moves.
   */
  private async fillFromCoordinates(latitude: number, longitude: number): Promise<void> {
    try {
      const place = await firstValueFrom(this.places.reverse(latitude, longitude));
      this.pinLabel.set(place.displayName ?? place.label);
      const fill = (name: AutoField, value?: string | null) => {
        const current = this.model()[name].trim();
        const ours = this.autoFilled.get(name);
        if (!value || (current && current !== ours)) return;
        this.form[name]().value.set(value);
        this.autoFilled.set(name, value);
      };
      fill('area', place.area);
      fill('city', place.city);
      fill('state', place.state);
      fill('postalCode', place.postalCode);
    } catch {
      // Naming the place is a convenience; the pin itself is what matters.
      this.pinLabel.set(null);
    }
  }

  /** Submit button click: remember the attempt so a missing pin is pointed out. */
  protected onSaveClick(): void {
    this.triedSave.set(true);
    // Make a missing pin visible even when the coordinate inputs are hidden.
    if (!this.pinned() && !this.geo.supported) this.showCoordinates.set(true);
  }

  private async save(): Promise<TreeValidationResult> {
    const v = this.model();
    // Optional fields are always sent (possibly empty) so clearing one in an edit really clears it.
    const input: AddressInput = {
      label: v.label,
      recipientName: v.recipientName.trim(),
      phone: v.phone.trim(),
      line1: v.line1.trim(),
      line2: v.line2.trim(),
      area: v.area.trim(),
      landmark: v.landmark.trim(),
      city: v.city.trim(),
      state: v.state.trim(),
      postalCode: v.postalCode.trim(),
      location: { latitude: Number(v.latitude), longitude: Number(v.longitude) },
      isDefault: v.isDefault,
    };
    this.error.set(null);
    try {
      this.ref.close(await firstValueFrom(this.data ? this.service.update(this.data.id, input) : this.service.create(input)));
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err));
      // The API reports coordinates as location.latitude / location.longitude.
      return serverErrors(this.form, fieldErrors(err).map((e) => ({ ...e, field: e.field.replace('location.', '') })));
    }
  }
}
