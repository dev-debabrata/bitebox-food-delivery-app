import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormRoot, form, maxLength, validate } from '@angular/forms/signals';
import { Observable, filter } from 'rxjs';
import { ButtonComponent } from 'nexprime';
import { NP_FORM_FIELDS } from '../../forms/np-form-fields';
import { BB_DIALOG_DATA, BbDialog, BbDialogRef, BbDialogTitle } from '../../dialog/bb-dialog';

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
  imports: [FormRoot, NP_FORM_FIELDS, BbDialogTitle, ButtonComponent],
  templateUrl: './confirm-dialog.html',
  styleUrl: './confirm-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialog {
  protected readonly data = inject<ConfirmDialogData>(BB_DIALOG_DATA);
  protected readonly ref = inject<BbDialogRef<true | string>>(BbDialogRef);

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

/**
 * Ask, then act: emits once if the user confirms (`true`, or the trimmed reason when
 * `reasonLabel` is set) and completes without emitting if they cancel or dismiss it.
 */
export function confirmed(
  dialog: BbDialog,
  data: ConfirmDialogData,
  width = '440px',
): Observable<true | string> {
  return dialog
    .open<ConfirmDialog, ConfirmDialogData, true | string>(ConfirmDialog, { data, width })
    .closed.pipe(
      filter(
        (result): result is true | string =>
          result === true || (typeof result === 'string' && result.length > 0),
      ),
    );
}
