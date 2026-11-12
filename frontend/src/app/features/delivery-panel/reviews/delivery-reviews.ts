import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { BbDialog } from '../../../shared/dialog/bb-dialog';
import { ButtonComponent, IconComponent, PaginationComponent } from 'nexprime';
import { NotificationService } from '../../../core/services/notification.service';
import { ReviewService } from '../../../core/services/review.service';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { RatingSummary } from '../../../shared/components/rating-summary/rating-summary';
import { reportReview } from '../../../shared/components/report-review-dialog/report-review-dialog';
import { ReviewCard } from '../../../shared/components/review-card/review-card';
import { pagedList } from '../../../shared/list/paged-list';
import { RiderReview } from '../../../shared/models/review.models';

/** The rider's delivery ratings. Read-only: riders can report a review but never change it. */
@Component({
  selector: 'bb-delivery-reviews',
  imports: [
    ButtonComponent,
    PaginationComponent,
    IconComponent,
    EmptyState,
    PageHeader,
    RatingSummary,
    ReviewCard,
  ],
  templateUrl: './delivery-reviews.html',
  styleUrl: './delivery-reviews.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeliveryReviews {
  private readonly reviews = inject(ReviewService);
  private readonly dialog = inject(BbDialog);
  private readonly notify = inject(NotificationService);

  protected readonly rating = signal<number | null>(null);
  protected readonly list = pagedList(
    (page, limit) =>
      this.reviews.riderReviews({ rating: this.rating() ?? undefined, page, limit }),
    { filterKey: () => String(this.rating()), limit: 10, errorText: 'Could not load your ratings.' },
  );

  protected report(review: RiderReview): void {
    reportReview(this.dialog, review.id).subscribe(() => {
      this.notify.success('Reported. The BiteBox team will review it.');
      this.list.reload();
    });
  }
}
