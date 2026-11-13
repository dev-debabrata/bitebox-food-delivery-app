import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { FormRoot, TreeValidationResult, form, pattern, required } from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import { errorMessage, fieldErrors } from '../../../../core/services/api-error';
import { KycService } from '../../../../core/services/kyc.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { serverErrors, shownError } from '../../../forms/form-errors';
import { matchesField, requiredText } from '../../../forms/form-rules';
import { NP_FORM_FIELDS } from '../../../forms/np-form-fields';
import { KycSummary, PayoutAccount } from '../../../models/kyc.models';

/**
 * The bank account BiteBox pays a partner into. The number goes to the API once and is stored
 * encrypted; only its last 4 digits come back.
 */
@Component({
  selector: 'bb-payout-account-form',
  imports: [FormRoot, NP_FORM_FIELDS],
  templateUrl: './payout-account-form.html',
  styleUrl: './payout-account-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PayoutAccountForm {
  private readonly api = inject(KycService);
  private readonly notify = inject(NotificationService);

  readonly account = input<PayoutAccount | null>(null);
  readonly saved = output<KycSummary>();

  protected readonly editing = signal(false);
  protected readonly shownError = shownError;
  protected readonly model = signal({
    holderName: '',
    accountNumber: '',
    confirmNumber: '',
    ifsc: '',
    bankName: '',
  });
  protected readonly form = form(
    this.model,
    (p) => {
      requiredText(p.holderName, 'Account holder name', { min: 2, max: 100 });
      required(p.accountNumber, { message: 'Enter the account number' });
      required(p.ifsc, { message: 'Enter the IFSC' });
      pattern(p.accountNumber, /^\d{9,18}$/, { message: 'Enter 9 to 18 digits' });
      matchesField(p.confirmNumber, p.accountNumber);
      pattern(p.ifsc, /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, {
        message: 'An IFSC looks like HDFC0001234',
      });
    },
    { submission: { action: () => this.save() } },
  );

  protected edit(on: boolean): void {
    this.editing.set(on);
    this.form().reset({
      holderName: this.account()?.holderName ?? '',
      accountNumber: '',
      confirmNumber: '',
      ifsc: this.account()?.ifsc ?? '',
      bankName: this.account()?.bankName ?? '',
    });
  }

  private async save(): Promise<TreeValidationResult> {
    const { holderName, accountNumber, ifsc, bankName } = this.model();
    try {
      const summary = await firstValueFrom(
        this.api.setPayoutAccount({
          holderName: holderName.trim(),
          accountNumber,
          ifsc: ifsc.toUpperCase(),
          bankName: bankName.trim(),
        }),
      );
      this.notify.success('Bank account saved');
      this.editing.set(false);
      this.saved.emit(summary);
      return undefined;
    } catch (err) {
      const fields = fieldErrors(err);
      if (!fields.length) this.notify.error(errorMessage(err));
      return serverErrors(this.form, fields);
    }
  }
}
