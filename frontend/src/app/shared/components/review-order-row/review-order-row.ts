import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ReviewTarget, subjectLabel } from '../../models/review.models';
import { Stars } from '../stars/stars';

export interface RowReview {
  id: string;
  target: ReviewTarget;
  rating: number;
  comment: string;
  foodName?: string | null;
  images?: string[];
  status?: string;
}

/**
 * One order in a review list: who and when, a chip per rated thing (restaurant, each dish, delivery),
 * the main comment and photo thumbnails. The host page wraps it in a button that opens the order.
 */
@Component({
  selector: 'bb-review-order-row',
  imports: [DatePipe, Stars],
  templateUrl: './review-order-row.html',
  styleUrl: './review-order-row.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewOrderRow {
  readonly orderNumber = input.required<string>();
  readonly author = input.required<string>();
  readonly date = input<string | null | undefined>(null);
  readonly subtitle = input<string | null>(null);
  readonly reviews = input.required<RowReview[]>();

  protected readonly chips = computed(() =>
    this.reviews().map((r) => ({
      id: r.id,
      label: subjectLabel(r),
      rating: r.rating,
      muted: !!r.status && r.status !== 'published',
    })),
  );
  /** The written words come with the restaurant review; fall back to any comment. */
  protected readonly comment = computed(
    () =>
      this.reviews().find((r) => r.target === 'restaurant' && r.comment)?.comment ??
      this.reviews().find((r) => r.comment)?.comment ??
      '',
  );
  protected readonly photos = computed(() => this.reviews().flatMap((r) => r.images ?? []));
}
