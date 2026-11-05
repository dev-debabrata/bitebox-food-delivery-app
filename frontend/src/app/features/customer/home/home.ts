import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import {
  ChangeDetectionStrategy,
  Component,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { FormRoot, form, validate } from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { AnimateOnScrollComponent, IconComponent } from 'nexprime';
import { Subscription, timeout } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { CatalogService } from '../../../core/services/catalog.service';
import { DeliveryLocationService } from '../../../core/services/delivery-location.service';
import { LocationPickerDialog } from '../../../shared/components/location-picker/location-picker-dialog';
import { RestaurantCard } from '../../../shared/components/restaurant-card/restaurant-card';
import { FoodCategory, Restaurant } from '../../../shared/models/catalog.models';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';

@Component({
  selector: 'bb-home',
  imports: [
    FormRoot,
    NP_FORM_FIELDS,
    RouterLink,
    MatButtonModule,
    IconComponent,
    NpIconPipe,
    RestaurantCard,
    AnimateOnScrollComponent,
  ],
  templateUrl: './home.html',
  styleUrl: './home.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
  private readonly catalog = inject(CatalogService);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  protected readonly user = this.auth.displayUser;
  protected readonly sessionChecked = this.auth.initialised;

  private readonly dialog = inject(MatDialog);
  protected readonly deliveryLocation = inject(DeliveryLocationService).location;

  protected readonly searchForm = form(
    signal({ search: '' }),
    (path) =>
      validate(path.search, ({ value }) => (value().trim() ? undefined : { kind: 'required' })),
    { submission: { action: async () => this.submitSearch() } },
  );
  protected readonly categories = signal<FoodCategory[] | null>(null);
  protected readonly restaurants = signal<Restaurant[]>([]);
  protected readonly loaded = signal<boolean | null>(null);
  private restaurantsRequest?: Subscription;

  constructor() {
    const browser = isPlatformBrowser(inject(PLATFORM_ID));
    this.catalog
      .categories()
      .pipe(browser ? (source) => source : timeout(2000))
      .subscribe({
        next: (c) => this.categories.set(c),
        error: () => browser && this.categories.set([]),
      });
    if (!browser) return;

    effect(() => {
      const location = this.deliveryLocation();
      untracked(() => {
        this.restaurantsRequest?.unsubscribe();
        this.loaded.set(null);
        this.restaurantsRequest = this.catalog
          .restaurants(
            location
              ? { lat: location.latitude, lng: location.longitude, sort: 'distance', limit: 8 }
              : { sort: 'rating', limit: 8 },
          )
          .subscribe({
            next: (res) => {
              this.restaurants.set(res.items);
              this.loaded.set(true);
            },
            error: () => this.loaded.set(false),
          });
      });
    });
  }

  /** The home page shows the first few categories; "View all" reveals the rest. */
  protected readonly categoryLimit = 8;
  protected readonly showAllCategories = signal(false);
  protected readonly visibleCategories = computed(() => {
    const all = this.categories() ?? [];
    return this.showAllCategories() ? all : all.slice(0, this.categoryLimit);
  });

  protected chooseLocation(): void {
    this.dialog.open(LocationPickerDialog, {
      width: '520px',
      maxWidth: '95vw',
      autoFocus: 'first-tabbable',
    });
  }

  protected focusIfEmpty(event: Event): void {
    if (this.searchForm().invalid()) {
      (event.currentTarget as HTMLFormElement).querySelector('input')?.focus();
    }
  }

  private submitSearch(): void {
    void this.router.navigate(['/restaurants'], {
      queryParams: { search: this.searchForm.search().value().trim() },
    });
  }

  protected readonly steps = [
    {
      icon: 'restaurant_menu',
      title: 'Pick a restaurant',
      text: 'Browse local kitchens, menus and ratings.',
    },
    {
      icon: 'shopping_bag',
      title: 'Fill your box',
      text: 'Add dishes, apply a coupon and choose how to pay.',
    },
    {
      icon: 'near_me',
      title: 'Track it live',
      text: 'Watch your rider on the map until it reaches your door.',
    },
  ];

  protected readonly heroIcons = ['local_pizza', 'ramen_dining', 'lunch_dining', 'icecream'];

  /** What BiteBox really offers (shown under the hero search). */
  protected readonly perks = [
    { icon: 'map-pin', text: 'Live order tracking' },
    { icon: 'wallet', text: 'Pay online or cash' },
    { icon: 'coins', text: 'Earn coins on every order' },
  ];

  /** A few categories as one-tap searches under the hero search box. */
  protected readonly quickPicks = computed(() => (this.categories() ?? []).slice(0, 5));
}
