import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {
  FormRoot,
  TreeValidationResult,
  form,
  maxLength,
  pattern,
  required,
} from '@angular/forms/signals';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { CheckboxComponent, IconComponent } from 'nexprime';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import { AddressService } from '../../../core/services/checkout-api.service';
import {
  DeliveryLocationService,
  Place,
  extractAddressFromPlace,
} from '../../../core/services/delivery-location.service';
import { PlaceSearch } from '../place-search/place-search';
import {
  GeolocationService,
  ImpreciseLocationError,
} from '../../../core/services/geolocation.service';
import { LatLng, MapPicker } from '../map-picker/map-picker';
import { AddressInput, AddressLabel, DeliveryAddress } from '../../models/checkout.models';
import { serverErrors, shownError } from '../../forms/form-errors';
import { POSTAL_CODE_PATTERN, numberRange, phoneRules, requiredText } from '../../forms/form-rules';
import { NP_FORM_FIELDS } from '../../forms/np-form-fields';
import { PhoneInput } from '../phone-input/phone-input';

type AutoField = 'line1' | 'line2' | 'area' | 'city' | 'state' | 'postalCode';

@Component({
  selector: 'bb-address-form-dialog',
  imports: [
    PhoneInput,
    PlaceSearch,
    CheckboxComponent,
    FormRoot,
    NP_FORM_FIELDS,
    MatDialogModule,
    MatButtonModule,
    MatButtonToggleModule,
    IconComponent,
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
  protected readonly pinLabel = signal<string | null>(null);
  protected readonly showCoordinates = signal(!this.geo.supported);
  protected readonly triedSave = signal(false);

  private readonly placeSearch = viewChild(PlaceSearch);

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
    return (
      latitude !== null &&
      longitude !== null &&
      this.form.latitude().valid() &&
      this.form.longitude().valid()
    );
  });
  protected readonly pinMissing = computed(() => this.triedSave() && !this.pinned());

  protected async useCurrentLocation(): Promise<void> {
    this.locating.set(true);
    this.locationError.set(null);
    try {
      const { latitude, longitude } = await this.geo.currentPrecise();
      await this.setPin({ latitude, longitude });
    } catch (err) {
      this.locationError.set(
        err instanceof ImpreciseLocationError
          ? err.message
          : `${(err as Error).message} Search for your area or tap the map instead.`,
      );
      this.placeSearch()?.focus();
    } finally {
      this.locating.set(false);
    }
  }

  protected async pickPlace(place: Place): Promise<void> {
    await this.setPin({ latitude: place.latitude, longitude: place.longitude }, place);
  }

  protected async onPinMoved(point: LatLng): Promise<void> {
    await this.setPin(point);
  }

  private async setPin({ latitude, longitude }: LatLng, knownPlace?: Place): Promise<void> {
    this.model.update((v) => ({
      ...v,
      latitude: +latitude.toFixed(6),
      longitude: +longitude.toFixed(6),
    }));
    await this.fillFromCoordinates(latitude, longitude, knownPlace);
  }

  private async fillFromCoordinates(
    latitude: number,
    longitude: number,
    knownPlace?: Place,
  ): Promise<void> {
    try {
      const place = knownPlace ?? (await firstValueFrom(this.places.reverse(latitude, longitude)));
      this.pinLabel.set(place.displayName ?? place.label);
      for (const [key, val] of Object.entries(extractAddressFromPlace(place)) as [
        AutoField,
        string,
      ][]) {
        const current = this.model()[key].trim();
        if (val && (!current || current === this.autoFilled.get(key))) {
          this.form[key]().value.set(val);
          this.autoFilled.set(key, val);
        }
      }
    } catch {
      this.pinLabel.set(null);
    }
  }

  protected onSaveClick(): void {
    this.triedSave.set(true);
    if (!this.pinned() && !this.geo.supported) this.showCoordinates.set(true);
  }

  private async save(): Promise<TreeValidationResult> {
    const v = this.model();
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
      this.ref.close(
        await firstValueFrom(
          this.data ? this.service.update(this.data.id, input) : this.service.create(input),
        ),
      );
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err));
      return serverErrors(
        this.form,
        fieldErrors(err).map((e) => ({ ...e, field: e.field.replace('location.', '') })),
      );
    }
  }
}
