import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormRoot, TreeValidationResult, form } from '@angular/forms/signals';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from 'nexprime';
import { firstValueFrom } from 'rxjs';
import { AdminRewardsService } from '../../../../core/services/admin/admin-rewards.service';
import { errorMessage, fieldErrors } from '../../../../core/services/api-error';
import { newIdempotencyKey } from '../../../../core/services/idempotency';
import { serverErrors, shownError } from '../../../../shared/forms/form-errors';
import { numberRange, requiredText } from '../../../../shared/forms/form-rules';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { AdminCoinTransaction, SOURCE_LABEL } from '../../../../shared/models/rewards.models';

/**
 * Claw back an earned reward, fully or partly (refund, fraud). Coins already spent become a
 * shortfall on the server; a balance never goes negative. One key per dialog, so a double
 * submit cannot reverse twice.
 */
@Component({
  selector: 'bb-reverse-dialog',
  imports: [DatePipe, FormRoot, NP_FORM_FIELDS, MatDialogModule, MatButtonModule, IconComponent],
  templateUrl: './reverse-dialog.html',
  styleUrl: './reverse-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReverseDialog {
  protected readonly txn = inject<AdminCoinTransaction>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<ReverseDialog, AdminCoinTransaction>);
  private readonly api = inject(AdminRewardsService);
  private readonly key = newIdempotencyKey();
  protected readonly sourceLabel = SOURCE_LABEL;
  protected readonly shownError = shownError;
  protected readonly error = signal<string | null>(null);

  protected readonly model = signal({ coins: this.txn.coins as number | null, reason: '' });
  protected readonly form = form(
    this.model,
    (p) => {
      numberRange(p.coins, 'Coins', 1, this.txn.coins);
      requiredText(p.reason, 'Reason', { min: 3, max: 300 });
    },
    { submission: { action: () => this.save() } },
  );

  private async save(): Promise<TreeValidationResult> {
    const v = this.model();
    this.error.set(null);
    try {
      this.ref.close(await firstValueFrom(this.api.reverse(this.txn.id, { coins: Number(v.coins), reason: v.reason.trim() }, this.key)));
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err));
      return serverErrors(this.form, fieldErrors(err));
    }
  }
}
