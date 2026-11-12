import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ButtonComponent, IconComponent } from 'nexprime';
import { Observable, filter } from 'rxjs';
import { errorMessage } from '../../../../core/services/api-error';
import { NotificationService } from '../../../../core/services/notification.service';
import { ReviewService } from '../../../../core/services/review.service';
import { confirmed } from '../../../../shared/components/confirm-dialog/confirm-dialog';
import { reportReview } from '../../../../shared/components/report-review-dialog/report-review-dialog';
import { ReviewCard } from '../../../../shared/components/review-card/review-card';
import {
  RestaurantOrderReviews,
  RestaurantReview,
  subjectLabel,
} from '../../../../shared/models/review.models';
import { ReplyForm } from '../reply-form/reply-form';
import {
  BB_DIALOG_DATA,
  BbDialog,
  BbDialogRef,
  BbDialogTitle,
} from '../../../../shared/dialog/bb-dialog';

/** Every review of one order: the restaurant's and each dish's, with replies and reporting. */
@Component({
  selector: 'bb-restaurant-order-dialog',
  imports: [DatePipe, BbDialogTitle, ButtonComponent, IconComponent, ReviewCard, ReplyForm],
  templateUrl: './restaurant-order-dialog.html',
  styleUrl: './restaurant-order-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RestaurantOrderDialog {
  private readonly orderId = inject<string>(BB_DIALOG_DATA);
  protected readonly ref = inject<BbDialogRef<boolean>>(BbDialogRef);
  private readonly reviews = inject(ReviewService);
  private readonly bbDialog = inject(BbDialog);
  private readonly notify = inject(NotificationService);

  protected readonly data = signal<RestaurantOrderReviews | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly replying = signal<string | null>(null);
  protected readonly changed = signal(false);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.error.set(null);
    this.reviews.restaurantOrder(this.orderId).subscribe({
      next: (d) => this.data.set(d),
      error: (err: unknown) => this.error.set(errorMessage(err, 'Could not load these reviews.')),
    });
  }

  protected readonly heading = subjectLabel;

  /** Swaps one review in place; the API answers with the updated review. */
  private patch(id: string, change: (r: RestaurantReview) => RestaurantReview): void {
    this.data.update((d) => {
      if (!d) return d;
      const reviews = d.reviews.map((r) => (r.id === id ? change(r) : r));
      return { ...d, reviews, unanswered: reviews.filter((r) => !r.response).length };
    });
  }

  protected replied(before: RestaurantReview, after: RestaurantReview): void {
    this.notify.success(before.response ? 'Reply saved' : 'Reply posted');
    this.replying.set(null);
    this.changed.set(true);
    this.patch(after.id, () => after);
  }

  protected deleteReply(review: RestaurantReview): void {
    confirmed(this.bbDialog, {
      title: 'Remove your reply?',
      message: `Your public reply to ${review.authorName} will be removed. The review stays.`,
      confirmLabel: 'Remove reply',
      danger: true,
    }).subscribe(() =>
      this.reviews.deleteResponse(review.id).subscribe({
        next: (updated) => {
          this.notify.success('Reply removed');
          this.changed.set(true);
          this.patch(updated.id, () => updated);
        },
        error: (err: unknown) => this.notify.error(errorMessage(err)),
      }),
    );
  }

  protected report(review: RestaurantReview): void {
    reportReview(this.bbDialog, review.id).subscribe(() => {
      this.notify.success('Reported. The BiteBox team will review it.');
      this.patch(review.id, (r) => ({ ...r, reportedByYou: true }));
    });
  }
}

/** Emits when a reply changed, so the list and the summary can refresh. */
export function openRestaurantOrderReviews(dialog: BbDialog, orderId: string): Observable<true> {
  return dialog
    .open<RestaurantOrderDialog, string, boolean>(RestaurantOrderDialog, {
      data: orderId,
      width: '720px',
    })
    .closed
    .pipe(filter((changed): changed is true => changed === true));
}
