import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import {
  FormRoot,
  TreeValidationResult,
  form,
  min,
  required,
  validate,
} from '@angular/forms/signals';
import { ButtonComponent, IconComponent } from 'nexprime';
import { finalize, firstValueFrom } from 'rxjs';
import { AuthService } from '../../../../core/auth/auth.service';
import {
  errorMessage,
  fieldErrors,
  resourceError,
  resourceValue,
} from '../../../../core/services/api-error';
import { ReportsService } from '../../../../core/services/reports.service';
import {
  BB_DIALOG_DATA,
  BbDialog,
  BbDialogRef,
  BbDialogTitle,
} from '../../../../shared/dialog/bb-dialog';
import { serverErrors, shownError } from '../../../../shared/forms/form-errors';
import { requiredText } from '../../../../shared/forms/form-rules';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import {
  AdminPayment,
  PAYMENT_STATUS_LABEL,
  REFUND_STATUS_LABEL,
  RefundInfo,
  paymentTone,
} from '../../../../shared/models/payment.models';
import { InrPipe, formatPaise, rupeesToPaise } from '../../../../shared/pipes/money.pipes';

/**
 * Full or partial refund of one payment (finance, `refunds:manage`), with the refunds so far.
 * Online refunds go back through the gateway; cash refunds are paid by hand and marked here.
 */
@Component({
  selector: 'bb-refund-dialog',
  imports: [
    DatePipe,
    FormRoot,
    NP_FORM_FIELDS,
    BbDialogTitle,
    ButtonComponent,
    IconComponent,
    InrPipe,
  ],
  templateUrl: './refund-dialog.html',
  styleUrl: './refund-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RefundDialog {
  protected readonly row = inject<AdminPayment>(BB_DIALOG_DATA);
  protected readonly ref = inject(BbDialogRef);
  private readonly api = inject(ReportsService);
  protected readonly canRefund = inject(AuthService).can('refunds:manage');
  protected readonly statusLabel = PAYMENT_STATUS_LABEL;
  protected readonly refundLabel = REFUND_STATUS_LABEL;
  protected readonly shownError = shownError;
  protected readonly tone = paymentTone;

  protected readonly detail = rxResource({
    params: () => this.row.id,
    stream: ({ params }) => this.api.payment(params),
  });
  protected readonly loadError = resourceError(this.detail, 'Could not load this payment.');
  protected readonly payment = resourceValue(this.detail);
  protected readonly left = computed(() => this.payment()?.refundablePaise ?? 0);

  protected readonly error = signal<string | null>(null);
  protected readonly marking = signal<string | null>(null);
  /** One key per refund attempt: a double click or a retried request refunds once. */
  private key = crypto.randomUUID();

  protected readonly model = signal({ amount: null as number | null, reason: '' });
  protected readonly form = form(
    this.model,
    (path) => {
      required(path.amount, { message: 'Enter an amount to refund' });
      min(path.amount, 1, { message: 'Refund at least ₹1' });
      validate(path.amount, ({ value }) => {
        const amount = value();
        return amount != null && rupeesToPaise(amount) > this.left()
          ? { kind: 'max', message: `At most ${formatPaise(this.left())} can be refunded` }
          : undefined;
      });
      requiredText(path.reason, 'Reason', { max: 300 });
    },
    { submission: { action: () => this.send() } },
  );

  protected all(): void {
    this.model.update((m) => ({ ...m, amount: this.left() / 100 }));
  }

  private async send(): Promise<TreeValidationResult> {
    this.error.set(null);
    const { amount, reason } = this.model();
    try {
      const payment = await firstValueFrom(
        this.api.refund(
          this.row.id,
          { amountPaise: rupeesToPaise(Number(amount)), reason: reason.trim() },
          this.key,
        ),
      );
      this.key = crypto.randomUUID();
      this.detail.set(payment);
      this.form().reset({ amount: null, reason: '' });
      return undefined;
    } catch (err) {
      const fields = fieldErrors(err);
      if (!fields.length) this.error.set(errorMessage(err, 'Could not start the refund.'));
      return serverErrors(this.form, fields);
    }
  }

  protected markPaid(refund: RefundInfo): void {
    this.marking.set(refund.id);
    this.error.set(null);
    this.api
      .markRefundPaid(refund.id)
      .pipe(finalize(() => this.marking.set(null)))
      .subscribe({
        next: (payment) => this.detail.set(payment),
        error: (err: unknown) => this.error.set(errorMessage(err)),
      });
  }
}

/** Emits once the dialog closes (refunds may have changed either way). */
export const openRefund = (dialog: BbDialog, payment: AdminPayment) =>
  dialog.open(RefundDialog, { data: payment, width: '520px' }).closed;
