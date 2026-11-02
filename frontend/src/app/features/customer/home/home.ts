import { ChangeDetectionStrategy, Component, PLATFORM_ID, effect, inject, signal, untracked } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { FormRoot, form, validate } from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog } from '@angular/material/dialog';
import { AnimateOnScrollComponent } from 'nexprime';
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
  imports: [FormRoot, NP_FORM_FIELDS, RouterLink, MatButtonModule, MatIconModule, RestaurantCard, AnimateOnScrollComponent],
  templateUrl: './home.html',
  styleUrl: './home.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
  private readonly catalog = inject(CatalogService);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  /** Real user, or the remembered one while the session is restored (display only). */
  protected readonly user = this.auth.displayUser;
  /** False until the browser has checked for a saved session (always false on the server). */
  protected readonly sessionChecked = this.auth.initialised;

  private readonly dialog = inject(MatDialog);
  protected readonly deliveryLocation = inject(DeliveryLocationService).location;

  /** Hero search: needs some text (an empty search would just open the full list). */
  protected readonly searchForm = form(
    signal({ search: '' }),
    (path) => validate(path.search, ({ value }) => (value().trim() ? undefined : { kind: 'required' })),
    { submission: { action: async () => this.submitSearch() } },
  );
  /** null = still loading. Fetched during server rendering too, so it is usually in the HTML. */
  protected readonly categories = signal<FoodCategory[] | null>(null);
  protected readonly restaurants = signal<Restaurant[]>([]);
  /** Popular restaurants: null = still loading. Browser only (they depend on the saved location). */
  protected readonly loaded = signal<boolean | null>(null);
  private restaurantsRequest?: Subscription;

  constructor() {
    const browser = isPlatformBrowser(inject(PLATFORM_ID));
    this.catalog
      .categories()
      // A slow API must not hold up the server render; the browser then fetches them itself.
      .pipe(browser ? (source) => source : timeout(2000))
      .subscribe({
        next: (c) => this.categories.set(c),
        error: () => browser && this.categories.set([]),
      });
    if (!browser) return;

    // Nearby restaurants when a delivery location is set, otherwise the most popular ones.
    effect(() => {
      const location = this.deliveryLocation();
      untracked(() => {
        this.restaurantsRequest?.unsubscribe();
        this.loaded.set(null);
        this.restaurantsRequest = this.catalog
          .restaurants(location ? { lat: location.latitude, lng: location.longitude, sort: 'distance', limit: 8 } : { sort: 'rating', limit: 8 })
          .subscribe({
            next: (res) => {
              this.restaurants.set(res.items);
              this.loaded.set(true);
            },
            // The rest of the page still works without this section.
            error: () => this.loaded.set(false),
          });
      });
    });
  }

  protected chooseLocation(): void {
    this.dialog.open(LocationPickerDialog, { width: '520px', maxWidth: '95vw', autoFocus: 'first-tabbable' });
  }

  /** An empty search stays here (validation blocks it); put the cursor in the box instead. */
  protected focusIfEmpty(event: Event): void {
    if (this.searchForm().invalid()) {
      (event.currentTarget as HTMLFormElement).querySelector('input')?.focus();
    }
  }

  private submitSearch(): void {
    void this.router.navigate(['/restaurants'], { queryParams: { search: this.searchForm.search().value().trim() } });
  }

  protected readonly steps = [
    { icon: 'restaurant_menu', title: 'Pick a restaurant', text: 'Browse local kitchens, menus and ratings.' },
    { icon: 'shopping_bag', title: 'Fill your box', text: 'Add dishes, apply a coupon and choose how to pay.' },
    { icon: 'near_me', title: 'Track it live', text: 'Watch your rider on the map until it reaches your door.' },
  ];

  /** Decorative icons floating around the hero illustration. */
  protected readonly heroIcons = ['local_pizza', 'ramen_dining', 'lunch_dining', 'icecream'];
}
