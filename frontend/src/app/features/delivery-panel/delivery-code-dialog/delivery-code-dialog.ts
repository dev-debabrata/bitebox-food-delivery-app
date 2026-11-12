import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  FormField,
  FormRoot,
  TreeValidationResult,
  form,
  pattern,
  required,
} from '@angular/forms/signals';
import { ButtonComponent, IconComponent, InputOtpComponent } from 'nexprime';
import { firstValueFrom } from 'rxjs';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import { RiderService } from '../../../core/services/order-management.service';
import { FieldError } from '../../../shared/forms/field-error/field-error';
import { serverErrors } from '../../../shared/forms/form-errors';
import {
  BB_DIALOG_DATA,
  BbDialog,
  BbDialogRef,
  BbDialogTitle,
} from '../../../shared/dialog/bb-dialog';
import { RiderDashboard, RiderOrder } from '../../../shared/models/order-management.models';

/**
 * "Delivered" with the customer's 4-digit code (master prompt §6 step 23). The dialog sends the
 * status itself, so a wrong code is shown here and the rider can try again; it closes with the
 * fresh dashboard once the order is delivered.
 */
@Component({
  selector: 'bb-delivery-code-dialog',
  imports: [
    FormRoot,
    FormField,
    FieldError,
    BbDialogTitle,
    ButtonComponent,
    IconComponent,
    InputOtpComponent,
  ],
  templateUrl: './delivery-code-dialog.html',
  styleUrl: './delivery-code-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeliveryCodeDialog {
  protected readonly order = inject<RiderOrder>(BB_DIALOG_DATA);
  protected readonly ref = inject<BbDialogRef<RiderDashboard>>(BbDialogRef);
  private readonly rider = inject(RiderService);

  protected readonly error = signal<string | null>(null);
  protected readonly model = signal({ otp: '' });
  protected readonly form = form(
    this.model,
    (path) => {
      required(path.otp, { message: "Enter the customer's 4-digit code" });
      pattern(path.otp, /^\d{4}$/, { message: "Enter the customer's 4-digit code" });
    },
    { submission: { action: () => this.send() } },
  );

  private async send(): Promise<TreeValidationResult> {
    this.error.set(null);
    try {
      const dashboard = await firstValueFrom(
        this.rider.setStatus(this.order.id, 'delivered', this.model().otp),
      );
      this.ref.close(dashboard);
      return undefined;
    } catch (err) {
      // A wrong code ("That code is not right. 4 tries left.") shows under the boxes. The value is
      // kept: Signal Forms drops a server error as soon as the field changes.
      const fields = fieldErrors(err);
      if (!fields.length) this.error.set(errorMessage(err, 'Could not complete the delivery.'));
      return serverErrors(this.form, fields);
    }
  }
}

export const openDeliveryCode = (dialog: BbDialog, order: RiderOrder) =>
  dialog.result<DeliveryCodeDialog, RiderOrder, RiderDashboard>(DeliveryCodeDialog, {
    data: order,
    width: '400px',
  });
