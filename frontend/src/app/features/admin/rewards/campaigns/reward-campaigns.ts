import { TableLabels } from '../../../../shared/list/table-labels';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatPaginatorModule } from '@angular/material/paginator';
import { IconComponent, SelectOption } from 'nexprime';
import { filter, switchMap } from 'rxjs';
import { AuthService } from '../../../../core/auth/auth.service';
import { AdminRewardsService } from '../../../../core/services/admin/admin-rewards.service';
import { errorMessage } from '../../../../core/services/api-error';
import { NotificationService } from '../../../../core/services/notification.service';
import { confirmed } from '../../../../shared/components/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { pagedList } from '../../../../shared/list/paged-list';
import {
  AdminCampaign,
  CAMPAIGN_STATUS_LABEL,
  CAMPAIGN_TYPE_LABEL,
  CampaignStatus,
  CampaignType,
} from '../../../../shared/models/rewards.models';
import { CampaignDetailDialog } from '../campaign-detail-dialog/campaign-detail-dialog';
import { CampaignFormDialog } from '../campaign-form-dialog/campaign-form-dialog';

type Action = 'activate' | 'pause' | 'end';

/** Festival and promotional campaigns: create, schedule, pause, end and follow them. */
@Component({
  selector: 'bb-reward-campaigns',
  imports: [
    TableLabels,DatePipe, NP_FORM_FIELDS, MatButtonModule, MatMenuModule, MatPaginatorModule, IconComponent, EmptyState, PageHeader],
  templateUrl: './reward-campaigns.html',
  styleUrl: './reward-campaigns.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RewardCampaignsPage {
  private readonly api = inject(AdminRewardsService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);
  protected readonly canManage = inject(AuthService).can('rewards:manage');
  protected readonly statusLabel = CAMPAIGN_STATUS_LABEL;
  protected readonly typeLabel = CAMPAIGN_TYPE_LABEL;
  protected readonly busy = signal<string | null>(null);

  protected readonly filterModel = signal({ status: '', type: '', search: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly statusOptions: SelectOption[] = [
    { value: '', label: 'Any status' },
    ...Object.entries(CAMPAIGN_STATUS_LABEL).map(([value, label]) => ({ value, label })),
  ];
  protected readonly typeOptions: SelectOption[] = [
    { value: '', label: 'Any type' },
    ...Object.entries(CAMPAIGN_TYPE_LABEL).map(([value, label]) => ({ value, label })),
  ];

  protected readonly list = pagedList(
    (page, limit) => {
      const f = this.filterModel();
      return this.api.campaigns({
        status: (f.status || undefined) as CampaignStatus | undefined,
        type: (f.type || undefined) as CampaignType | undefined,
        search: f.search.trim() || undefined,
        page,
        limit,
      });
    },
    { filterKey: () => JSON.stringify(this.filterModel()), errorText: 'Could not load campaigns.' },
  );

  protected tone(status: CampaignStatus): string {
    return status === 'ACTIVE' ? 'tone-good' : status === 'SCHEDULED' ? 'tone-info' : status === 'PAUSED' ? 'tone-warn' : '';
  }

  protected actions(c: AdminCampaign): Action[] {
    const moves: Record<CampaignStatus, Action[]> = {
      DRAFT: ['activate', 'end'],
      SCHEDULED: ['pause', 'end'],
      ACTIVE: ['pause', 'end'],
      PAUSED: ['activate', 'end'],
      EXPIRED: [],
      COMPLETED: [],
    };
    return moves[c.status];
  }

  protected readonly actionLabel: Record<Action, string> = { activate: 'Activate', pause: 'Pause', end: 'End now' };

  protected open(campaign?: AdminCampaign): void {
    this.dialog
      .open<CampaignFormDialog, AdminCampaign | null, AdminCampaign>(CampaignFormDialog, {
        data: campaign ?? null,
        width: '620px',
        maxWidth: '95vw',
      })
      .afterClosed()
      .pipe(filter(Boolean))
      .subscribe(() => {
        this.notify.success(campaign ? 'Campaign saved' : 'Draft created');
        this.list.reload();
      });
  }

  protected details(c: AdminCampaign): void {
    this.dialog.open(CampaignDetailDialog, { data: c.id, width: '680px', maxWidth: '95vw' });
  }

  protected act(c: AdminCampaign, action: Action): void {
    const messages: Record<Action, string> = {
      activate:
        new Date(c.startAt).getTime() > Date.now()
          ? `It will start on ${new Date(c.startAt).toLocaleString('en-IN')}.`
          : 'Customers can get it right away.',
      pause: 'Customers cannot get it until you activate it again.',
      end: 'It stops for good. Rewards already given are kept.',
    };
    confirmed(this.dialog, {
      title: `${this.actionLabel[action]} “${c.name}”?`,
      message: messages[action],
      confirmLabel: this.actionLabel[action],
      danger: action === 'end',
    })
      .pipe(
        switchMap(() => {
          this.busy.set(c.id);
          return this.api.setCampaignStatus(c.id, action);
        }),
      )
      .subscribe({
        next: (updated) => {
          this.busy.set(null);
          this.notify.success(`Campaign ${this.statusLabel[updated.status].toLowerCase()}`);
          this.list.reload();
        },
        error: (err: unknown) => {
          this.busy.set(null);
          this.notify.error(errorMessage(err));
        },
      });
  }
}
