import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from 'nexprime';
import { ReviewReply } from '../../../../shared/components/review-reply/review-reply';
import { Stars } from '../../../../shared/components/stars/stars';
import {
  AdminReviewDetail,
  REPORT_REASON_LABEL,
  STATUS_LABEL,
  TARGET_LABEL,
} from '../../../../shared/models/review.models';

const ACTION_LABEL: Record<string, string> = {
  hide: 'Hidden',
  remove: 'Removed',
  restore: 'Restored',
  dismiss_reports: 'Reports dismissed',
};

/**
 * One review's history for moderators: the words as written, earlier versions, every report and
 * the moderation log. Read-only; the order dialog holds the actions.
 */
@Component({
  selector: 'bb-admin-review-dialog',
  imports: [DatePipe, MatDialogModule, MatButtonModule, IconComponent, Stars, ReviewReply],
  templateUrl: './admin-review-dialog.html',
  styleUrl: './admin-review-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminReviewDialog {
  protected readonly r = inject<AdminReviewDetail>(MAT_DIALOG_DATA);
  protected readonly targetLabel = TARGET_LABEL;
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly reasonLabel = REPORT_REASON_LABEL;
  protected readonly actionLabel = ACTION_LABEL;
}

export function openReviewHistory(dialog: MatDialog, review: AdminReviewDetail): void {
  dialog.open<AdminReviewDialog, AdminReviewDetail>(AdminReviewDialog, {
    data: review,
    width: '720px',
    maxWidth: '95vw',
    autoFocus: 'dialog',
  });
}
