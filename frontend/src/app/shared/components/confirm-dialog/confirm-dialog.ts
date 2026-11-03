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
  /** When set, the user must type a reason (returned as the dialog result). */
  reasonLabel?: string;
}

/**
 * Generic confirmation. Closes with `true`, the typed reason (if
 * `reasonLabel` is set), or `undefined` when cancelled.
 */
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
      // Only asked for when the caller wants a reason; whitespace does not count.
      validate(path.reason, ({ value }) =>
        this.data.reasonLabel && !value().trim()
          ? { kind: 'required', message: 'A reason is required' }
          : undefined,
      );
      maxLength(path.reason, 500, { message: 'Keep it under 500 characters' });
    },
    {
      submission: {
        action: async () =>
          this.ref.close(this.data.reasonLabel ? this.model().reason.trim() : true),
      },
    },
  );
}

/**
 * Opens the confirmation and emits only if the user confirms: `true`, or the
 * typed reason when `reasonLabel` is set. Cancelling emits nothing.
 */
export function confirmed(
  dialog: MatDialog,
  data: ConfirmDialogData,
  width = '440px',
): Observable<true | string> {
  return dialog
    .open<ConfirmDialog, ConfirmDialogData, true | string>(ConfirmDialog, { data, width })
    .afterClosed()
    .pipe(
      // Only an explicit confirmation counts: a bare `mat-dialog-close` closes with '' (not undefined).
      filter((result): result is true | string => result === true || (typeof result === 'string' && result.length > 0)),
    );
}
