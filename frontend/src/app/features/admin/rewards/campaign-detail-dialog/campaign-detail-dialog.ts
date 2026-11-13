import { TableLabels } from '../../../../shared/list/table-labels';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from 'nexprime';
import { AdminRewardsService } from '../../../../core/services/admin/admin-rewards.service';
import { resourceError, resourceValue } from '../../../../core/services/api-error';
import { StatTile } from '../../../../shared/components/stat-tile/stat-tile';
import { CAMPAIGN_STATUS_LABEL, CAMPAIGN_STATUS_TONE, CUSTOMER_GROUP_LABEL } from '../../../../shared/models/rewards.models';
import { InrPipe } from '../../../../shared/pipes/money.pipes';

/** A campaign's settings, performance and latest claims. */
@Component({
  selector: 'bb-campaign-detail-dialog',
  imports: [
    TableLabels,DatePipe, MatDialogModule, MatButtonModule, IconComponent, StatTile, InrPipe],
  templateUrl: './campaign-detail-dialog.html',
  styleUrl: './campaign-detail-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CampaignDetailDialog {
  private readonly id = inject<string>(MAT_DIALOG_DATA);
  private readonly api = inject(AdminRewardsService);
  protected readonly statusLabel = CAMPAIGN_STATUS_LABEL;
  protected readonly statusTone = CAMPAIGN_STATUS_TONE;
  protected readonly groupLabel = CUSTOMER_GROUP_LABEL;
  protected readonly detail = rxResource({ stream: () => this.api.campaign(this.id) });
  protected readonly data = resourceValue(this.detail);
  protected readonly error = resourceError(this.detail, 'Could not load the campaign.');
}
