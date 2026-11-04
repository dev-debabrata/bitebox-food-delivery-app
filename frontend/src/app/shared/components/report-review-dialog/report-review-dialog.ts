import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormRoot, TreeValidationResult, form, maxLength, required } from '@angular/forms/signals';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent, SelectOption } from 'nexprime';
import { Observable, filter, firstValueFrom } from 'rxjs';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import { ReviewService } from '../../../core/services/review.service';
import { serverErrors, shownError } from '../../forms/form-errors';
import { NP_FORM_FIELDS } from '../../forms/np-form-fields';
import { REPORT_REASON_LABEL, REVIEW_LIMITS, ReportReason } from '../../models/review.models';

export interface ReportReviewData {
  reviewId: string;
}

@Component({
  selector: 'bb-report-review-dialog',
  imports: [FormRoot, NP_FORM_FIELDS, MatDialogModule, MatButtonModule, IconComponent],
  templateUrl: './report-review-dialog.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportReviewDialog {
  private readonly data = inject<ReportReviewData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<ReportReviewDialog, true>);
  private readonly reviews = inject(ReviewService);
  protected readonly shownError = shownError;
  protected readonly error = signal<string | null>(null);
  protected readonly reasons: SelectOption[] = (
    Object.keys(REPORT_REASON_LABEL) as ReportReason[]
  ).map((value) => ({ value, label: REPORT_REASON_LABEL[value] }));

  protected readonly model = signal({ reason: '', note: '' });
  protected readonly form = form(
    this.model,
    (path) => {
      required(path.reason, { message: 'Choose what is wrong' });
      maxLength(path.note, REVIEW_LIMITS.reportNote, {
        message: `Keep the note under ${REVIEW_LIMITS.reportNote} characters`,
      });
    },
    { submission: { action: () => this.send() } },
  );

  private async send(): Promise<TreeValidationResult> {
    const { reason, note } = this.model();
    this.error.set(null);
    try {
      await firstValueFrom(
        this.reviews.report(this.data.reviewId, {
          reason: reason as ReportReason,
          note: note.trim() || undefined,
        }),
      );
      this.ref.close(true);
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err, 'Could not send the report.'));
      return serverErrors(this.form, fieldErrors(err));
    }
  }
}

/** Emits once the report is stored. */
export function reportReview(dialog: MatDialog, reviewId: string): Observable<true> {
  return dialog
    .open<ReportReviewDialog, ReportReviewData, true>(ReportReviewDialog, {
      data: { reviewId },
      width: '440px',
      maxWidth: '95vw',
    })
    .afterClosed()
    .pipe(filter((r): r is true => r === true));
}
