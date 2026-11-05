import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormRoot, TreeValidationResult, form, pattern, required } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { IconComponent, SelectOption } from 'nexprime';
import { Observable, firstValueFrom } from 'rxjs';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import { SupportService } from '../../../core/services/support.service';
import { serverErrors, shownError } from '../../../shared/forms/form-errors';
import { requiredText } from '../../../shared/forms/form-rules';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { MyTicket, TICKET_TYPE_LABEL, TicketType } from '../../../shared/models/admin-roles.models';

export interface NewTicketData {
  orderNumber?: string;
  type?: TicketType;
}

@Component({
  selector: 'bb-new-ticket-dialog',
  imports: [FormRoot, NP_FORM_FIELDS, MatDialogModule, MatButtonModule, IconComponent],
  templateUrl: './new-ticket-dialog.html',
  styleUrl: './new-ticket-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NewTicketDialog {
  private readonly data = inject<NewTicketData | null>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<NewTicketDialog, MyTicket>);
  private readonly api = inject(SupportService);
  protected readonly shownError = shownError;
  protected readonly error = signal<string | null>(null);

  protected readonly typeOptions: SelectOption[] = (
    Object.keys(TICKET_TYPE_LABEL) as TicketType[]
  ).map((t) => ({ value: t, label: TICKET_TYPE_LABEL[t] }));

  protected readonly model = signal({
    type: (this.data?.type ?? (this.data?.orderNumber ? 'order_issue' : '')) as string,
    orderNumber: this.data?.orderNumber ?? '',
    subject: '',
    message: '',
  });
  protected readonly form = form(
    this.model,
    (path) => {
      required(path.type, { message: 'Choose what this is about' });
      pattern(path.orderNumber, /^(BB-\d{6}-[A-Za-z0-9]{6})?$/, {
        message: 'Order numbers look like BB-261105-ABC123',
      });
      requiredText(path.subject, 'Subject', { min: 5, max: 120 });
      requiredText(path.message, 'Message', { min: 2, max: 2000 });
    },
    { submission: { action: () => this.save() } },
  );

  private async save(): Promise<TreeValidationResult> {
    const v = this.model();
    this.error.set(null);
    try {
      this.ref.close(
        await firstValueFrom(
          this.api.create({
            type: v.type as TicketType,
            subject: v.subject.trim(),
            message: v.message.trim(),
            orderNumber: v.orderNumber.trim().toUpperCase() || undefined,
          }),
        ),
      );
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err));
      return serverErrors(this.form, fieldErrors(err));
    }
  }
}

export const openNewTicket = (
  dialog: MatDialog,
  data: NewTicketData | null = null,
): Observable<MyTicket | undefined> =>
  dialog
    .open<NewTicketDialog, NewTicketData | null, MyTicket>(NewTicketDialog, {
      data,
      width: '540px',
      maxWidth: '95vw',
    })
    .afterClosed();
