import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { IconComponent } from 'nexprime';
import { errorMessage } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { ReviewService } from '../../../core/services/review.service';
import { ReviewOrderRow } from '../../../shared/components/review-order-row/review-order-row';
import { MyReview, OrderReviewState, isEditable } from '../../../shared/models/review.models';
import { openRateOrder } from '../rate-order-dialog/rate-order-dialog';

/**
 * Ratings on a delivered order, as one card: "How was your order?" until something is rated, then
 * a summary of the ratings. Either way one button opens the rating dialog (rate, edit, delete).
 */
@Component({
  selector: 'bb-order-reviews',
  imports: [DatePipe, RouterLink, MatButtonModule, IconComponent, ReviewOrderRow],
  templateUrl: './order-reviews.html',
  styleUrl: './order-reviews.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrderReviews {
  private readonly reviews = inject(ReviewService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);

  readonly orderId = input.required<string>();
  readonly orderNumber = input<string>('');
  readonly riderName = input<string | null>(null);
  /** Open the dialog as soon as the state loads (e.g. from "Rate this order" in the order list). */
  readonly autoOpen = input(false);

  protected readonly state = signal<OrderReviewState | null>(null);
  protected readonly error = signal<string | null>(null);
  private autoOpened = false;

  /** Every rating given on this order, restaurant first. */
  protected readonly rated = computed<MyReview[]>(() => {
    const s = this.state();
    if (!s) return [];
    return [
      s.restaurant.review,
      ...s.items.map((i) => i.review),
      s.rider?.review ?? null,
    ].filter((r): r is MyReview => !!r);
  });
  protected readonly unrated = computed(() => {
    const s = this.state();
    if (!s) return 0;
    return (
      (s.restaurant.review ? 0 : 1) +
      s.items.filter((i) => !i.review).length +
      (s.rider && !s.rider.review ? 1 : 0)
    );
  });
  protected readonly canRate = computed(() => !!this.state()?.canReview && this.unrated() > 0);
  protected readonly canEdit = computed(() => this.rated().some(isEditable));
  protected readonly moderated = computed(() => this.rated().filter((r) => r.status !== 'published'));

  constructor() {
    effect(() => {
      const id = this.orderId();
      untracked(() => this.load(id));
    });
  }

  protected load(id = this.orderId()): void {
    this.error.set(null);
    this.reviews.forOrder(id).subscribe({
      next: (state) => {
        this.state.set(state);
        if (this.autoOpen() && !this.autoOpened && this.canRate()) {
          this.autoOpened = true;
          this.open();
        }
      },
      error: (err: unknown) => this.error.set(errorMessage(err, 'Could not load your reviews.')),
    });
  }

  protected open(): void {
    const state = this.state();
    if (!state) return;
    const firstTime = this.rated().length === 0;
    openRateOrder(this.dialog, {
      state,
      orderNumber: this.orderNumber(),
      riderName: this.riderName(),
    }).subscribe((updated) => {
      this.state.set(updated);
      this.notify.success(firstTime ? 'Thanks for rating your order!' : 'Your ratings are updated');
    });
  }
}
