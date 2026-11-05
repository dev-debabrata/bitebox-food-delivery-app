import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import { MatPaginatorModule } from '@angular/material/paginator';
import { IconComponent, SelectOption } from 'nexprime';
import { AdminRewardsService } from '../../../../core/services/admin/admin-rewards.service';
import { EmptyState } from '../../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { pagedList } from '../../../../shared/list/paged-list';
import { REWARD_TYPE_LABEL, RewardType } from '../../../../shared/models/rewards.models';

/** Reward distribution history: every welcome, birthday and campaign reward given. */
@Component({
  selector: 'bb-reward-history',
  imports: [DatePipe, NP_FORM_FIELDS, MatPaginatorModule, IconComponent, EmptyState, PageHeader],
  templateUrl: './reward-history.html',
  styleUrl: './reward-history.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RewardHistoryPage {
  private readonly api = inject(AdminRewardsService);
  protected readonly typeLabel = REWARD_TYPE_LABEL;
  protected readonly filterModel = signal({ rewardType: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly typeOptions: SelectOption[] = [
    { value: '', label: 'All rewards' },
    ...Object.entries(REWARD_TYPE_LABEL).map(([value, label]) => ({ value, label })),
  ];
  protected readonly list = pagedList(
    (page, limit) =>
      this.api.claims({ rewardType: (this.filterModel().rewardType || undefined) as RewardType | undefined, page, limit }),
    { filterKey: () => this.filterModel().rewardType, errorText: 'Could not load the reward history.' },
  );
}
