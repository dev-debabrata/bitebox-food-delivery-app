import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { form } from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent, ToggleComponent } from 'nexprime';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog } from '@angular/material/dialog';
import { Subscription, catchError, debounceTime, distinctUntilChanged, of } from 'rxjs';
import { CatalogService } from '../../../core/services/catalog.service';
import { errorMessage } from '../../../core/services/api-error';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { VegBadge } from '../../../shared/components/veg-badge/veg-badge';
import { Pagination } from '../../../shared/models/api.models';
import { DishSearchResult } from '../../../shared/models/catalog.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';
import { FoodDetailDialog, FoodDetailData } from '../food-detail-dialog/food-detail-dialog';

/** Food search: available dishes across all approved restaurants. */
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';

@Component({
  selector: 'bb-food-search',
  imports: [
    ToggleComponent,
    NP_FORM_FIELDS,
    RouterLink,
    MatButtonModule,
    MatChipsModule,
    IconComponent, NpIconPipe,
    EmptyState,
    VegBadge,
    InrPipe,
  ],
  templateUrl: './food-search.html',
  styleUrl: './food-search.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FoodSearch {
  private readonly catalog = inject(CatalogService);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);

  readonly search = input<string>();
  readonly category = input<string>();
  readonly veg = input<string>();

  protected readonly categories = toSignal(this.catalog.categories().pipe(catchError(() => of([]))), { initialValue: [] });
  /** The search box; the URL (?search=) is the source of truth for what is shown. */
  protected readonly filters = form(signal({ search: '' }));
  protected readonly dishes = signal<DishSearchResult[]>([]);
  protected readonly pagination = signal<Pagination | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  private inFlight?: Subscription;

  protected readonly vegOnly = computed(() => this.veg() === 'true');
  protected readonly canLoadMore = computed(() => {
    const p = this.pagination();
    return !!p && p.page < p.totalPages;
  });
  private readonly query = computed(() => ({
    search: this.search() || undefined,
    category: this.category() || undefined,
    veg: this.vegOnly() || undefined,
    limit: 20,
  }));

  constructor() {
    effect(() => {
      const query = this.query();
      untracked(() => {
        // Follow the URL (back/forward, links) without fighting what is being typed.
        const box = this.filters.search().value;
        if (box().trim() !== (query.search ?? '')) box.set(query.search ?? '');
        this.load(1);
      });
    });
    toObservable(computed(() => this.filters.search().value().trim()))
      .pipe(debounceTime(400), distinctUntilChanged(), takeUntilDestroyed())
      .subscribe((search) => {
        if (search !== (this.search() ?? '')) this.setParams({ search: search || null });
      });
  }

  protected setParams(params: Record<string, string | boolean | null>): void {
    void this.router.navigate([], { queryParams: params, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected load(page: number): void {
    const append = page > 1;
    this.inFlight?.unsubscribe();
    this.loading.set(!append);
    this.error.set(null);
    this.inFlight = this.catalog.dishes({ ...this.query(), page }).subscribe({
      next: (res) => {
        this.dishes.update((current) => (append ? [...current, ...res.items] : res.items));
        this.pagination.set(res.pagination);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(errorMessage(err, 'Could not search dishes.'));
        this.loading.set(false);
      },
    });
  }

  protected loadMore(): void {
    const p = this.pagination();
    if (p) this.load(p.page + 1);
  }

  protected open(dish: DishSearchResult): void {
    this.dialog.open<FoodDetailDialog, FoodDetailData>(FoodDetailDialog, {
      data: {
        item: { ...dish, category: dish.category ? { name: dish.category.name, icon: dish.category.icon } : null },
        restaurant: { name: dish.restaurant.name, slug: dish.restaurant.slug },
        showRestaurantLink: true,
      },
      width: '480px',
      maxWidth: '95vw',
      autoFocus: 'dialog',
    });
  }
}
