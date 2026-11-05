import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from 'nexprime';
import { AdminRewardsService } from '../../../../core/services/admin/admin-rewards.service';
import { resourceError, resourceValue } from '../../../../core/services/api-error';
import { StatTile } from '../../../../shared/components/stat-tile/stat-tile';
import { SOURCE_LABEL, TXN_TYPE_LABEL } from '../../../../shared/models/rewards.models';

/** One customer's wallet: balances, live batches, the ledger check and recent rows. */
@Component({
  selector: 'bb-wallet-dialog',
  imports: [DatePipe, MatDialogModule, MatButtonModule, IconComponent, StatTile],
  templateUrl: './wallet-dialog.html',
  styleUrl: './wallet-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WalletDialog {
  private readonly userId = inject<string>(MAT_DIALOG_DATA);
  private readonly api = inject(AdminRewardsService);
  protected readonly sourceLabel = SOURCE_LABEL;
  protected readonly typeLabel = TXN_TYPE_LABEL;
  protected readonly detail = rxResource({ stream: () => this.api.wallet(this.userId) });
  protected readonly data = resourceValue(this.detail);
  protected readonly error = resourceError(this.detail, 'Could not load the wallet.');
}
