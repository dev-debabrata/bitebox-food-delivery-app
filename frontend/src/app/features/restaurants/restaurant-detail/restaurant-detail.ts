import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent, ToggleComponent } from 'nexprime';
import { MatDialog } from '@angular/material/dialog';
import { HttpErrorResponse } from '@angular/common/http';
import { forkJoin } from 'rxjs';
import { CartActions } from '../../../core/services/cart-actions.service';
import { CartService } from '../../../core/services/cart.service';
import { CatalogService } from '../../../core/services/catalog.service';
import { errorMessage } from '../../../core/services/api-error';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { QtyStepper } from '../../../shared/components/qty-stepper/qty-stepper';
import { VegBadge } from '../../../shared/components/veg-badge/veg-badge';
import { FoodItem, MenuSection, Restaurant } from '../../../shared/models/catalog.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';
import { FoodDetailDialog, FoodDetailData } from '../../food/food-detail-dialog/food-detail-dialog';

import { form } from '@angular/forms/signals';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';

@Component({
  selector: 'bb-restaurant-detail',
  imports: [
    ToggleComponent,
    NP_FORM_FIELDS,
    RouterLink,
    MatButtonModule,
    IconComponent, NpIconPipe,
    EmptyState,
    QtyStepper,
    VegBadge,
    InrPipe,
  ],
  templateUrl: './restaurant-detail.html',
  styleUrl: './restaurant-detail.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RestaurantDetail {
  private readonly catalog = inject(CatalogService);
  private readonly dialog = inject(MatDialog);
  private readonly title = inject(Title);
  private readonly document = inject(DOCUMENT);
  protected readonly cart = inject(CartService);
  protected readonly cartActions = inject(CartActions);

  /** Route param :slug */
  readonly slug = input.required<string>();

  protected readonly restaurant = signal<Restaurant | null>(null);
  protected readonly sections = signal<MenuSection[]>([]);
  protected readonly loading = signal(true);
  protected readonly notFound = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly vegOnly = signal(false);
  /** "Search this menu" box (filters locally). */
  protected readonly menuSearch = form(signal({ search: '' }));

  protected readonly rating = computed(() => {
    const r = this.restaurant()?.rating;
    return r && r.count > 0 ? r.average.toFixed(1) : null;
  });

  /** Menu after the veg / search filters. Empty sections are dropped. */
  protected readonly visibleSections = computed(() => {
    const term = this.menuSearch.search().value().trim().toLowerCase();
    const veg = this.vegOnly();
    return this.sections()
      .map((s) => ({
        ...s,
        items: s.items.filter((i) => (!veg || i.isVeg) && (!term || i.name.toLowerCase().includes(term) || i.description?.toLowerCase().includes(term))),
      }))
      .filter((s) => s.items.length > 0);
  });

  /** CSS value for the hero background (URL is quoted; the API also rejects quotes/parens in image URLs). */
  protected readonly heroImage = computed(() => {
    const url = this.restaurant()?.imageUrl;
    return url ? `url("${url}")` : null;
  });

  /** Cart summary for the sticky bar, only when the cart belongs to this restaurant. */
  protected readonly cartHere = computed(() => {
    const quote = this.cart.quote();
    return quote?.cart && quote.cart.restaurant?.id === this.restaurant()?.id ? quote.cart : null;
  });
  protected readonly cartSubtotal = computed(() => this.cart.quote()?.pricing.subtotalPaise ?? 0);

  protected readonly itemCount = computed(() => this.sections().reduce((n, s) => n + s.items.length, 0));

  constructor() {
    effect(() => {
      const slug = this.slug();
      untracked(() => this.load(slug));
    });
  }

  protected load(slug = this.slug()): void {
    this.loading.set(true);
    this.error.set(null);
    this.notFound.set(false);
    forkJoin({ restaurant: this.catalog.restaurant(slug), sections: this.catalog.menu(slug) }).subscribe({
      next: ({ restaurant, sections }) => {
        this.restaurant.set(restaurant);
        this.sections.set(sections);
        this.title.setTitle(`${restaurant.name} | BiteBox`);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        if (err instanceof HttpErrorResponse && err.status === 404) this.notFound.set(true);
        else this.error.set(errorMessage(err, 'Could not load this restaurant.'));
        this.loading.set(false);
      },
    });
  }

  protected canOrder(): boolean {
    return this.cartActions.canOrder();
  }

  /** Open and accepting orders right now (the server re-checks at checkout). */
  protected readonly takingOrders = computed(() => {
    const r = this.restaurant();
    return !!r && r.isOpenNow && r.isAcceptingOrders;
  });

  protected quantityOf(foodItemId: string): number {
    return this.cartHere() ? this.cart.quantityOf(foodItemId) : 0;
  }

  protected addToCart(item: FoodItem): void {
    this.cartActions.add(item.id, item.name);
  }

  protected sectionId(section: MenuSection): string {
    return `menu-${section.category?.slug ?? 'other'}`;
  }

  protected scrollTo(section: MenuSection): void {
    this.document.getElementById(this.sectionId(section))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  protected openItem(item: FoodItem): void {
    const restaurant = this.restaurant();
    if (!restaurant) return;
    this.dialog.open<FoodDetailDialog, FoodDetailData>(FoodDetailDialog, {
      data: {
        item: { ...item, category: item.category ? { name: item.category.name, icon: item.category.icon } : null },
        restaurant: { name: restaurant.name, slug: restaurant.slug, isOpenNow: restaurant.isOpenNow },
      },
      width: '480px',
      maxWidth: '95vw',
      autoFocus: 'dialog',
    });
  }
}
