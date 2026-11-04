import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatPaginatorModule } from '@angular/material/paginator';
import { IconComponent, SelectOption } from 'nexprime';
import { errorMessage } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { ReviewService } from '../../../core/services/review.service';
import { confirmed } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { ReviewCard } from '../../../shared/components/review-card/review-card';
import { openReviewForm } from '../../../shared/components/review-form-dialog/review-form-dialog';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { pagedList } from '../../../shared/list/paged-list';
import {
  MyReview,
  ReviewTarget,
  STATUS_LABEL,
  TARGET_LABEL,
  TARGET_PLURAL,
  isEditable,
  subjectLabel,
} from '../../../shared/models/review.models';

/** Everything the customer has reviewed, with edit and delete where the policy allows. */
@Component({
  selector: 'bb-my-reviews',
  imports: [
    RouterLink,
    NP_FORM_FIELDS,
    MatButtonModule,
    MatPaginatorModule,
    IconComponent,
    EmptyState,
    PageHeader,
    ReviewCard,
  ],
  templateUrl: './my-reviews.html',
  styleUrl: './my-reviews.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MyReviews {
  private readonly reviews = inject(ReviewService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);

  protected readonly targetLabel = TARGET_LABEL;
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly filterModel = signal({ target: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly targetOptions: SelectOption[] = [
    { value: '', label: 'All reviews' },
    ...(Object.keys(TARGET_PLURAL) as ReviewTarget[]).map((t) => ({ value: t, label: TARGET_PLURAL[t] })),
  ];
  protected readonly editable = isEditable;

  protected readonly list = pagedList(
    (page, limit) =>
      this.reviews.mine({
        target: (this.filterModel().target || undefined) as ReviewTarget | undefined,
        page,
        limit,
      }),
    {
      filterKey: () => this.filterModel().target,
      limit: 10,
      errorText: 'Could not load your reviews.',
    },
  );

  protected subject(r: MyReview): string {
    const where = r.restaurantName ?? TARGET_LABEL.restaurant;
    return r.target === 'restaurant' ? where : `${subjectLabel(r)} · ${where}`;
  }

  protected edit(r: MyReview): void {
    openReviewForm(this.dialog, { subject: this.subject(r), review: r }).subscribe(() => {
      this.notify.success('Review updated');
      this.list.reload();
    });
  }

  protected remove(r: MyReview): void {
    confirmed(this.dialog, {
      title: 'Delete this review?',
      message: "It will be removed from BiteBox. You won't be able to review this again for that order.",
      confirmLabel: 'Delete review',
      danger: true,
    }).subscribe(() =>
      this.reviews.remove(r.id).subscribe({
        next: () => {
          this.notify.success('Review deleted');
          this.list.reload();
        },
        error: (err: unknown) => this.notify.error(errorMessage(err)),
      }),
    );
  }
}
