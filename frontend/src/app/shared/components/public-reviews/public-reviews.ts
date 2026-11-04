import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { IconComponent, SelectComponent } from 'nexprime';
import { Observable } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { errorMessage } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { ReviewListQuery, ReviewService } from '../../../core/services/review.service';
import {
  PublicReview,
  RatingSummary as Summary,
  ReviewPage,
  ReviewSort,
  SORT_OPTIONS,
} from '../../models/review.models';
import { RatingSummary } from '../rating-summary/rating-summary';
import { reportReview } from '../report-review-dialog/report-review-dialog';
import { ReviewCard } from '../review-card/review-card';

/**
 * The public reviews of a restaurant or a dish: summary with star filter, sort, "show more" and,
 * for signed-in customers, reporting.
 */
@Component({
  selector: 'bb-public-reviews',
  imports: [MatButtonModule, IconComponent, SelectComponent, RatingSummary, ReviewCard],
  templateUrl: './public-reviews.html',
  styleUrl: './public-reviews.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PublicReviews {
  private readonly reviews = inject(ReviewService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);
  private readonly auth = inject(AuthService);

  /** Restaurant slug or food item id. */
  readonly subject = input.required<{ kind: 'restaurant' | 'food'; key: string }>();
  readonly responder = input('The restaurant');
  readonly pageSize = input(5);

  protected readonly items = signal<PublicReview[]>([]);
  protected readonly summary = signal<Summary | null>(null);
  protected readonly total = signal(0);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly rating = signal<number | null>(null);
  protected readonly sort = signal<ReviewSort>('newest');
  protected readonly reported = signal<ReadonlySet<string>>(new Set());
  private page = 1;

  protected readonly canReport = computed(() => this.auth.role() === 'customer');
  protected readonly sortOptions = SORT_OPTIONS;
  protected readonly hasMore = computed(() => this.items().length < this.total());

  constructor() {
    effect(() => {
      this.subject();
      this.rating();
      this.sort();
      untracked(() => this.load(1));
    });
  }

  private fetch(query: ReviewListQuery): Observable<ReviewPage<PublicReview>> {
    const { kind, key } = this.subject();
    return kind === 'restaurant'
      ? this.reviews.restaurantReviews(key, query)
      : this.reviews.foodReviews(key, query);
  }

  protected load(page: number): void {
    this.page = page;
    this.loading.set(true);
    this.error.set(null);
    this.fetch({
      page,
      limit: this.pageSize(),
      sort: this.sort(),
      rating: this.rating() ?? undefined,
    }).subscribe({
      next: (res) => {
        this.items.update((list) => (page === 1 ? res.items : [...list, ...res.items]));
        this.total.set(res.pagination.total);
        if (res.summary) this.summary.set(res.summary);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(errorMessage(err, 'Could not load reviews.'));
        this.loading.set(false);
      },
    });
  }

  protected more(): void {
    this.load(this.page + 1);
  }

  protected setSort(value: string): void {
    this.sort.set(value as ReviewSort);
  }

  protected report(review: PublicReview): void {
    reportReview(this.dialog, review.id).subscribe(() => {
      this.reported.update((s) => new Set(s).add(review.id));
      this.notify.success('Thanks. Our team will take a look.');
    });
  }
}
