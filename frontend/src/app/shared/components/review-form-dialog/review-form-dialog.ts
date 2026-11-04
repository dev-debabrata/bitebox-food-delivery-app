import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormRoot, TreeValidationResult, form, maxLength, min } from '@angular/forms/signals';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from 'nexprime';
import { Observable, filter, firstValueFrom } from 'rxjs';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import { ReviewService } from '../../../core/services/review.service';
import { serverErrors } from '../../forms/form-errors';
import { NP_FORM_FIELDS } from '../../forms/np-form-fields';
import { MyReview, RATING_WORDS, REVIEW_LIMITS, ReviewTarget } from '../../models/review.models';
import { PhotoUpload } from '../photo-upload/photo-upload';

export interface ReviewFormData {
  /** What was rated, e.g. "Spice Route Kitchen" or "Garlic Naan · Spice Route Kitchen". */
  subject: string;
  review: MyReview;
}

const PROMPT: Record<ReviewTarget, string> = {
  restaurant: 'How was the food and service?',
  food: 'How was this dish?',
  rider: 'How was the delivery?',
};

/** Edits one of the customer's reviews: stars, words and (except delivery ratings) photos. */
@Component({
  selector: 'bb-review-form-dialog',
  imports: [
    DatePipe,
    FormRoot,
    NP_FORM_FIELDS,
    MatDialogModule,
    MatButtonModule,
    IconComponent,
    PhotoUpload,
  ],
  templateUrl: './review-form-dialog.html',
  styleUrl: './review-form-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewFormDialog {
  protected readonly data = inject<ReviewFormData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<ReviewFormDialog, MyReview>);
  private readonly reviews = inject(ReviewService);

  private readonly review = this.data.review;
  protected readonly words = [...RATING_WORDS];
  protected readonly prompt = PROMPT[this.review.target];
  protected readonly error = signal<string | null>(null);
  protected readonly photos = signal<string[]>([...this.review.images]);
  protected readonly allowsPhotos = this.review.target !== 'rider';

  protected readonly model = signal({ rating: this.review.rating, comment: this.review.comment });

  protected readonly form = form(
    this.model,
    (path) => {
      min(path.rating, 1, { message: 'Choose from 1 to 5 stars' });
      maxLength(path.comment, REVIEW_LIMITS.comment, {
        message: `Keep it under ${REVIEW_LIMITS.comment} characters`,
      });
    },
    { submission: { action: () => this.save() } },
  );

  private async save(): Promise<TreeValidationResult> {
    const { rating, comment } = this.model();
    this.error.set(null);
    try {
      const request = this.reviews.update(this.review.id, {
        rating,
        comment: comment.trim(),
        ...(this.allowsPhotos && { images: this.photos() }),
      });
      this.ref.close(await firstValueFrom(request));
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err, 'Could not save your review.'));
      return serverErrors(this.form, fieldErrors(err));
    }
  }
}

/** Opens the edit dialog; emits the saved review. */
export function openReviewForm(dialog: MatDialog, data: ReviewFormData): Observable<MyReview> {
  return dialog
    .open<ReviewFormDialog, ReviewFormData, MyReview>(ReviewFormDialog, {
      data,
      width: '480px',
      maxWidth: '95vw',
    })
    .afterClosed()
    .pipe(filter((r): r is MyReview => !!r));
}
