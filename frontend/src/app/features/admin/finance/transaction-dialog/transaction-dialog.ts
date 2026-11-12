import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { IconComponent } from 'nexprime';
import { Observable } from 'rxjs';
import { FinanceService } from '../../../../core/services/admin/finance.service';
import { resourceError } from '../../../../core/services/api-error';
import { ORDER_STATUS_LABEL } from '../../../../shared/models/checkout.models';
import { PAYMENT_STATUS_LABEL, PROVIDER_LABEL } from '../../../../shared/models/payment.models';
import { InrPipe } from '../../../../shared/pipes/money.pipes';

/** One payment with its customer, order prices and settlement split (finance view). */
@Component({
  selector: 'bb-transaction-dialog',
  imports: [DatePipe, MatDialogModule, MatButtonModule, IconComponent, InrPipe],
  templateUrl: './transaction-dialog.html',
  styleUrl: './transaction-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransactionDialog {
  private readonly id = inject<string>(MAT_DIALOG_DATA);
  private readonly api = inject(FinanceService);
  protected readonly statusLabel = PAYMENT_STATUS_LABEL;
  protected readonly providerLabel = PROVIDER_LABEL;
  protected readonly orderStatus = ORDER_STATUS_LABEL;

  protected readonly tx = rxResource({
    params: () => this.id,
    stream: ({ params }) => this.api.transaction(params),
  });
  protected readonly error = resourceError(this.tx, 'Could not load this transaction.');
}

export const openTransaction = (dialog: MatDialog, paymentId: string): Observable<unknown> =>
  dialog
    .open(TransactionDialog, { data: paymentId, width: '620px', maxWidth: '95vw', autoFocus: 'dialog' })
    .afterClosed();
