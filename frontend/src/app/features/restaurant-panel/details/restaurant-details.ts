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
  applyEach,
  form,
  maxLength,
  pattern,
  required,
  validate,
} from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ChipComponent, IconComponent, ToggleComponent } from 'nexprime';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import {
  DeliveryLocationService,
  Place,
  extractAddressFromPlace,
} from '../../../core/services/delivery-location.service';
import { PlaceSearch } from '../../../shared/components/place-search/place-search';
import {
  GeolocationService,
  ImpreciseLocationError,
} from '../../../core/services/geolocation.service';
import { MyRestaurantService } from '../../../core/services/my-restaurant.service';
import { NotificationService } from '../../../core/services/notification.service';
import { ImageUpload } from '../../../shared/components/image-upload/image-upload';
import { LatLng, MapPicker } from '../../../shared/components/map-picker/map-picker';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { serverErrors, shownError } from '../../../shared/forms/form-errors';
import {
  POSTAL_CODE_PATTERN,
  emailRules,
  numberRange,
  phoneRules,
  requiredText,
} from '../../../shared/forms/form-rules';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { Restaurant, RestaurantInput } from '../../../shared/models/catalog.models';
import { rupeesToPaise } from '../../../shared/pipes/money.pipes';
import { StatusBanner } from '../status-banner/status-banner';
import { PhoneInput } from '../../../shared/components/phone-input/phone-input';

function timeToDate(time: string): Date {
  const [h, m] = time.split(':').map(Number);
  const date = new Date();
  date.setHours(h, m, 0, 0);
  return date;
}
const dateToTime = (date: Date) =>
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

function emptyModel() {
  return {
    name: '',
    description: '',
    cuisines: [] as string[],
    phone: '',
    email: '',
    address: { line1: '', line2: '', area: '', city: '', state: '', postalCode: '' },
    location: { latitude: null as number | null, longitude: null as number | null },
    isPureVeg: false,
    costForTwo: null as number | null,
    minOrder: 0 as number | null,
    avgPrepTimeMinutes: 25 as number | null,
    openingTime: timeToDate('10:00') as Date | null,
    closingTime: timeToDate('23:00') as Date | null,
  };
}

@Component({
  selector: 'bb-restaurant-details',
  imports: [
    PhoneInput,
    PlaceSearch,
    ToggleComponent,
    FormRoot,
    NP_FORM_FIELDS,
    ChipComponent,
    MatButtonModule,
    IconComponent,
    MatProgressSpinnerModule,
    ImageUpload,
    MapPicker,
    PageHeader,
    StatusBanner,
  ],
  templateUrl: './restaurant-details.html',
  styleUrl: './restaurant-details.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RestaurantDetails {
  private readonly service = inject(MyRestaurantService);
  private readonly notify = inject(NotificationService);
  private readonly router = inject(Router);
  protected readonly geo = inject(GeolocationService);
  private readonly places = inject(DeliveryLocationService);

  protected readonly shownError = shownError;

  protected readonly restaurant = signal<Restaurant | null>(null);
  protected readonly loading = signal(true);
  protected readonly locating = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly imageUrl = signal('');
  private readonly saved = signal('');
  private readonly snapshot = () => JSON.stringify({ ...this.model(), imageUrl: this.imageUrl() });
  protected readonly changed = computed(
    () => this.restaurant() === null || this.snapshot() !== this.saved(),
  );

  protected readonly cuisineDraft = signal('');
  protected readonly cuisineError = signal<string | null>(null);

  protected readonly locationError = signal<string | null>(null);
  protected readonly pinLabel = signal<string | null>(null);
  protected readonly showCoordinates = signal(false);
  private readonly placeSearch = viewChild(PlaceSearch);

  protected readonly model = signal(emptyModel());
  protected readonly form = form(
    this.model,
    (path) => {
      requiredText(path.name, 'Name', { min: 2, max: 100 });
      maxLength(path.description, 1000, { message: 'Keep the description under 1000 characters' });
      validate(path.cuisines, ({ value }) =>
        value().length === 0
          ? { kind: 'required', message: 'Add at least one cuisine' }
          : value().length > 10
            ? { kind: 'maxItems', message: 'Add at most 10 cuisines' }
            : undefined,
      );
      applyEach(path.cuisines, (cuisine) => requiredText(cuisine, 'Cuisine', { min: 2, max: 40 }));
      phoneRules(path.phone);
      emailRules(path.email, { optional: true });
      requiredText(path.address.line1, 'Street address', { min: 3, max: 120 });
      maxLength(path.address.line2, 120, { message: 'Keep it under 120 characters' });
      maxLength(path.address.area, 80, { message: 'Keep it under 80 characters' });
      requiredText(path.address.city, 'City', { min: 2, max: 80 });
      requiredText(path.address.state, 'State', { min: 2, max: 80 });
      required(path.address.postalCode, { message: 'PIN code is required' });
      pattern(path.address.postalCode, POSTAL_CODE_PATTERN, { message: 'Enter a valid PIN code' });
      numberRange(path.location.latitude, 'Latitude', -90, 90);
      numberRange(path.location.longitude, 'Longitude', -180, 180);
      numberRange(path.costForTwo, 'Cost for two', 0, 100_000);
      numberRange(path.minOrder, 'Minimum order', 0, 100_000, { optional: true });
      numberRange(path.avgPrepTimeMinutes, 'Preparation time', 5, 180);
      required(path.openingTime, { message: 'Opening time is required' });
      required(path.closingTime, { message: 'Closing time is required' });
    },
    { submission: { action: () => this.save() } },
  );

  constructor() {
    this.service.get().subscribe({
      next: ({ restaurant }) => {
        if (restaurant) this.fill(restaurant);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(errorMessage(err, 'Could not load your restaurant.'));
        this.loading.set(false);
      },
    });
  }

  private fill(r: Restaurant): void {
    this.restaurant.set(r);
    this.imageUrl.set(r.imageUrl ?? '');
    this.form().reset({
      name: r.name,
      description: r.description ?? '',
      cuisines: [...r.cuisines],
      phone: r.phone,
      email: r.email ?? '',
      address: {
        line1: r.address.line1,
        line2: r.address.line2 ?? '',
        area: r.address.area ?? '',
        city: r.address.city,
        state: r.address.state,
        postalCode: r.address.postalCode,
      },
      location: { latitude: r.location.coordinates[1], longitude: r.location.coordinates[0] },
      isPureVeg: r.isPureVeg,
      costForTwo: r.costForTwoPaise / 100,
      minOrder: r.minOrderPaise / 100,
      avgPrepTimeMinutes: r.avgPrepTimeMinutes,
      openingTime: timeToDate(r.openingTime),
      closingTime: timeToDate(r.closingTime),
    });
    this.pinLabel.set(
      [r.address.line1, r.address.area, r.address.city, r.address.state]
        .filter(Boolean)
        .join(', ') || null,
    );
    this.saved.set(this.snapshot());
  }

  protected onCuisineKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ',') return;
    event.preventDefault(); // Enter must not submit the whole form
    this.addCuisine();
  }

  private addCuisine(): void {
    const value = this.cuisineDraft().replace(/,/g, '').trim();
    this.cuisineDraft.set('');
    if (!value) return;
    const cuisines = this.model().cuisines;
    if (value.length < 2 || value.length > 40) {
      this.cuisineError.set('Each cuisine must be 2-40 characters');
      return;
    }
    if (cuisines.length >= 10) {
      this.cuisineError.set('Add at most 10 cuisines');
      return;
    }
    if (!cuisines.some((c) => c.toLowerCase() === value.toLowerCase())) {
      this.form.cuisines().value.set([...cuisines, value]);
    }
    this.form.cuisines().markAsTouched();
    this.cuisineError.set(null);
  }

  protected removeCuisine(cuisine: string): void {
    this.form.cuisines().value.update((list) => list.filter((c) => c !== cuisine));
    this.form.cuisines().markAsTouched();
  }

  protected async useCurrentLocation(): Promise<void> {
    this.locating.set(true);
    this.locationError.set(null);
    try {
      const point = await this.geo.currentPrecise();
      await this.setPin(point);
    } catch (err) {
      this.locationError.set(
        err instanceof ImpreciseLocationError ? err.message : (err as Error).message,
      );
      this.placeSearch()?.focus();
    } finally {
      this.locating.set(false);
    }
  }

  protected async pickPlace(place: Place): Promise<void> {
    await this.setPin(place, place);
  }

  protected async setPin({ latitude, longitude }: LatLng, knownPlace?: Place): Promise<void> {
    this.form
      .location()
      .value.set({ latitude: +latitude.toFixed(6), longitude: +longitude.toFixed(6) });
    this.form.location().markAsTouched();
    try {
      const place = knownPlace ?? (await firstValueFrom(this.places.reverse(latitude, longitude)));
      this.pinLabel.set(
        place.displayName || place.label || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
      );
      type AddressKey = 'line1' | 'line2' | 'area' | 'city' | 'state' | 'postalCode';
      const extracted = extractAddressFromPlace(place);
      for (const key of Object.keys(extracted) as AddressKey[]) {
        const val = extracted[key];
        if (val && !this.model().address[key]?.trim()) this.form.address[key]().value.set(val);
      }
    } catch {
      this.pinLabel.set(`${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
    }
  }

  private async save(): Promise<TreeValidationResult> {
    const v = this.model();
    const input: RestaurantInput = {
      name: v.name.trim(),
      description: v.description.trim(),
      cuisines: v.cuisines,
      phone: v.phone.trim(),
      ...(v.email.trim() ? { email: v.email.trim() } : {}),
      address: {
        line1: v.address.line1.trim(),
        city: v.address.city.trim(),
        state: v.address.state.trim(),
        postalCode: v.address.postalCode.trim(),
        ...(v.address.line2.trim() ? { line2: v.address.line2.trim() } : {}),
        ...(v.address.area.trim() ? { area: v.address.area.trim() } : {}),
      },
      location: { latitude: Number(v.location.latitude), longitude: Number(v.location.longitude) },
      imageUrl: this.imageUrl(),
      isPureVeg: v.isPureVeg,
      costForTwoPaise: rupeesToPaise(Number(v.costForTwo)),
      minOrderPaise: rupeesToPaise(Number(v.minOrder ?? 0)),
      avgPrepTimeMinutes: Number(v.avgPrepTimeMinutes),
      openingTime: dateToTime(v.openingTime!),
      closingTime: dateToTime(v.closingTime!),
    };

    const creating = this.restaurant() === null;
    this.error.set(null);
    try {
      const restaurant = await firstValueFrom(
        creating ? this.service.create(input) : this.service.update(input),
      );
      this.fill(restaurant);
      this.notify.success(
        creating ? 'Restaurant submitted for approval' : 'Restaurant details saved',
      );
      if (creating) void this.router.navigateByUrl('/restaurant');
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err, 'Could not save your restaurant.'));
      return serverErrors(this.form, fieldErrors(err));
    }
  }
}
