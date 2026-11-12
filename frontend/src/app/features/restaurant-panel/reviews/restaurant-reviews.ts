import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { form } from '@angular/forms/signals';
import { BbDialog } from '../../../shared/dialog/bb-dialog';
import { IconComponent, PaginationComponent, SelectOption } from 'nexprime';
import { errorMessage } from '../../../core/services/api-error';
import { ReviewService } from '../../../core/services/review.service';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { RatingSummary } from '../../../shared/components/rating-summary/rating-summary';
import { ReviewOrderRow } from '../../../shared/components/review-order-row/review-order-row';
import { Stars } from '../../../shared/components/stars/stars';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { pagedList } from '../../../shared/list/paged-list';
import {
  RestaurantOrderReviews,
  RestaurantReviewSummary,
  ReviewSort,
  RATING_FILTER_OPTIONS,
  SORT_OPTIONS,
} from '../../../shared/models/review.models';
import { openRestaurantOrderReviews } from './order-dialog/restaurant-order-dialog';

const ANY = '';

interface Filters {
  target: string;
  foodItemId: string;
  rating: string;
  responded: string;
  sort: string;
}

/** Reviews of the restaurant and its dishes, one row per order; the order dialog holds the replies. */
@Component({
  selector: 'bb-restaurant-reviews',
  imports: [
    DecimalPipe,
    NP_FORM_FIELDS,
    PaginationComponent,
    IconComponent,
    EmptyState,
    PageHeader,
    RatingSummary,
    ReviewOrderRow,
    Stars,
  ],
  templateUrl: './restaurant-reviews.html',
  styleUrl: './restaurant-reviews.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RestaurantReviews {
  private readonly reviews = inject(ReviewService);
  private readonly dialog = inject(BbDialog);

  protected readonly summary = signal<RestaurantReviewSummary | null>(null);
  protected readonly summaryError = signal<string | null>(null);

  protected readonly filterModel = signal<Filters>({
    target: ANY,
    foodItemId: ANY,
    rating: ANY,
    responded: ANY,
    sort: 'newest',
  });
  protected readonly filters = form(this.filterModel);

  protected readonly targetOptions: SelectOption[] = [
    { value: ANY, label: 'Restaurant and dishes' },
    { value: 'restaurant', label: 'Restaurant only' },
    { value: 'food', label: 'Dishes only' },
  ];
  protected readonly ratingOptions = RATING_FILTER_OPTIONS;
  protected readonly respondedOptions: SelectOption[] = [
    { value: ANY, label: 'Replied or not' },
    { value: 'false', label: 'Needs a reply' },
    { value: 'true', label: 'Replied' },
  ];
  protected readonly sortOptions = SORT_OPTIONS;
  protected readonly foodOptions = computed<SelectOption[]>(() => [
    { value: ANY, label: 'Any dish' },
    ...(this.summary()?.foods ?? []).map((f) => ({ value: f.id, label: f.name })),
  ]);
  protected readonly ratedFoods = computed(() =>
    (this.summary()?.foods ?? []).filter((f) => f.rating.count > 0),
  );
  protected readonly selectedRating = computed(() => Number(this.filterModel().rating) || null);

  protected readonly list = pagedList(
    (page, limit) => {
      const f = this.filterModel();
      return this.reviews.restaurantOrders({
        target: (f.target || undefined) as 'restaurant' | 'food' | undefined,
        foodItemId: f.foodItemId || undefined,
        rating: Number(f.rating) || undefined,
        responded: f.responded ? f.responded === 'true' : undefined,
        sort: f.sort as ReviewSort,
        page,
        limit,
      });
    },
    {
      filterKey: () => JSON.stringify(this.filterModel()),
      limit: 10,
      errorText: 'Could not load reviews.',
    },
  );

  constructor() {
    this.loadSummary();
  }

  protected loadSummary(): void {
    this.summaryError.set(null);
    this.reviews.restaurantSummary().subscribe({
      next: (s) => this.summary.set(s),
      error: (err: unknown) => this.summaryError.set(errorMessage(err, 'Could not load ratings.')),
    });
  }

  protected filterBy(patch: Partial<Filters>): void {
    this.filterModel.update((f) => ({ ...f, ...patch }));
  }

  protected open(row: RestaurantOrderReviews): void {
    openRestaurantOrderReviews(this.dialog, row.order).subscribe(() => {
      this.list.reload();
      this.loadSummary();
    });
  }
}
