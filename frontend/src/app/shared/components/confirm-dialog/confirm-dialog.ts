import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormRoot, form, maxLength, validate } from '@angular/forms/signals';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { Observable, filter } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { NP_FORM_FIELDS } from '../../forms/np-form-fields';

export interface ConfirmDialogData {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  reasonLabel?: string;
  /** Longest reason the API accepts (default 500). */
  reasonMax?: number;
}

@Component({
  selector: 'bb-confirm-dialog',
  imports: [FormRoot, NP_FORM_FIELDS, MatDialogModule, MatButtonModule],
  templateUrl: './confirm-dialog.html',
  styleUrl: './confirm-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialog {
  protected readonly data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<ConfirmDialog, true | string>);

  protected readonly model = signal({ reason: '' });
  protected readonly form = form(
    this.model,
    (path) => {
      validate(path.reason, ({ value }) =>
        this.data.reasonLabel && !value().trim()
          ? { kind: 'required', message: 'A reason is required' }
          : undefined,
      );
      const max = this.data.reasonMax ?? 500;
      maxLength(path.reason, max, { message: `Keep it under ${max} characters` });
    },
    {
      submission: {
        action: async () =>
          this.ref.close(this.data.reasonLabel ? this.model().reason.trim() : true),
      },
    },
  );
}

export function confirmed(
  dialog: MatDialog,
  data: ConfirmDialogData,
  width = '440px',
): Observable<true | string> {
  return dialog
    .open<ConfirmDialog, ConfirmDialogData, true | string>(ConfirmDialog, { data, width })
    .afterClosed()
    .pipe(
      filter(
        (result): result is true | string =>
          result === true || (typeof result === 'string' && result.length > 0),
      ),
    );
}
