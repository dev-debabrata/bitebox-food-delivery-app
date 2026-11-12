import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from 'nexprime';
import { Observable, filter } from 'rxjs';
import { errorMessage } from '../../../../core/services/api-error';
import { NotificationService } from '../../../../core/services/notification.service';
import { ReviewService } from '../../../../core/services/review.service';
import { confirmed } from '../../../../shared/components/confirm-dialog/confirm-dialog';
import { ReviewCard, ReviewCardData } from '../../../../shared/components/review-card/review-card';
import {
  AdminOrderReviews,
  AdminReviewDetail,
  MODERATION_COPY,
  ModerationAction,
  REPORT_REASON_LABEL,
  REVIEW_LIMITS,
  STATUS_LABEL,
  subjectLabel,
} from '../../../../shared/models/review.models';
import { openAdminOrder } from '../../orders/admin-order-dialog/admin-order-dialog';
import { openReviewHistory } from '../admin-review-dialog/admin-review-dialog';

const card = (r: AdminReviewDetail): ReviewCardData => ({
  rating: r.rating,
  comment: r.comment,
  authorName: r.customer?.name ?? r.customerName,
  createdAt: r.createdAt,
  editedAt: r.editedAt,
  images: r.images ?? [],
  response: r.response?.text
    ? {
        text: r.response.text,
        respondedAt: r.response.respondedAt ?? '',
        updatedAt: r.response.updatedAt ?? r.response.respondedAt ?? '',
      }
    : null,
});

/**
 * Every review of one order for moderators: the restaurant's, each dish's and the delivery rating,
 * with their reports and the hide / remove / restore / dismiss actions (always with a reason).
 */
@Component({
  selector: 'bb-admin-order-reviews-dialog',
  imports: [MatDialogModule, MatButtonModule, IconComponent, ReviewCard],
  templateUrl: './admin-order-reviews-dialog.html',
  styleUrl: './admin-order-reviews-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminOrderReviewsDialog {
  private readonly orderId = inject<string>(MAT_DIALOG_DATA);
  private readonly reviews = inject(ReviewService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);

  protected readonly data = signal<AdminOrderReviews<AdminReviewDetail> | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal<string | null>(null);
  protected readonly changed = signal(false);
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly reasonLabel = REPORT_REASON_LABEL;

  /** Built once per change, not on every render. */
  protected readonly rows = computed(() =>
    (this.data()?.reviews ?? []).map((r) => ({
      r,
      heading:
        r.target === 'rider'
          ? `Delivery · ${r.deliveryPartner?.name ?? 'Rider'}`
          : r.target === 'food'
            ? `Dish · ${subjectLabel(r)}`
            : `Restaurant · ${r.restaurant?.name ?? ''}`,
      card: card(r),
      openReports: r.reports.filter((rep) => rep.status === 'open'),
    })),
  );

  constructor() {
    this.load();
  }

  protected load(): void {
    this.error.set(null);
    this.reviews.adminOrder(this.orderId).subscribe({
      next: (d) => this.data.set(d),
      error: (err: unknown) => this.error.set(errorMessage(err, 'Could not load these reviews.')),
    });
  }

  protected act(r: AdminReviewDetail, action: ModerationAction | 'dismiss'): void {
    const copy = MODERATION_COPY[action];
    confirmed(
      this.dialog,
      {
        title: copy.title,
        message: copy.message,
        confirmLabel: copy.confirm,
        danger: copy.danger,
        reasonLabel: copy.reasonLabel,
        reasonMax: REVIEW_LIMITS.moderationReason,
      },
      '460px',
    ).subscribe((reason) => {
      this.busy.set(r.id);
      const request =
        action === 'dismiss'
          ? this.reviews.dismissReports(r.id, String(reason))
          : this.reviews.moderate(r.id, action, String(reason));
      request.subscribe({
        next: (updated) => {
          this.busy.set(null);
          this.changed.set(true);
          this.notify.success(copy.done);
          this.replace(updated);
        },
        error: (err: unknown) => {
          this.busy.set(null);
          this.notify.error(errorMessage(err));
          this.load();
        },
      });
    });
  }

  protected history(r: AdminReviewDetail): void {
    openReviewHistory(this.dialog, r);
  }

  protected openOrder(): void {
    openAdminOrder(this.dialog, this.orderId).subscribe();
  }

  /** The API answers with the moderated review; swap it in instead of reloading the order. */
  private replace(updated: AdminReviewDetail): void {
    this.data.update((d) => {
      if (!d) return d;
      const reviews = d.reviews.map((x) => (x.id === updated.id ? updated : x));
      return { ...d, reviews, openReports: reviews.reduce((n, x) => n + x.openReports, 0) };
    });
  }
}

/** Emits when something was moderated, so the list can reload. */
export function openAdminOrderReviews(dialog: MatDialog, orderId: string): Observable<true> {
  return dialog
    .open<AdminOrderReviewsDialog, string, boolean>(AdminOrderReviewsDialog, {
      data: orderId,
      width: '760px',
      maxWidth: '95vw',
      autoFocus: 'dialog',
    })
    .afterClosed()
    .pipe(filter((changed): changed is true => changed === true));
}
