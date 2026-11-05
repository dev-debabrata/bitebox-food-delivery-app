import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormRoot, TreeValidationResult, form, required } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatPaginatorModule } from '@angular/material/paginator';
import { IconComponent, SelectOption } from 'nexprime';
import { firstValueFrom } from 'rxjs';
import { errorMessage, fieldErrors, resourceError, resourceValue } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { RewardsService } from '../../../core/services/rewards.service';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { StatTile } from '../../../shared/components/stat-tile/stat-tile';
import { serverErrors } from '../../../shared/forms/form-errors';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { pagedList } from '../../../shared/list/paged-list';
import {
  CustomerCampaign,
  REWARD_TYPE_LABEL,
  RewardType,
} from '../../../shared/models/rewards.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';
import { RewardsNav } from '../rewards-nav/rewards-nav';

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Special rewards: birthday and welcome bonuses, campaigns to claim, and reward history. */
@Component({
  selector: 'bb-special-rewards',
  imports: [
    DatePipe,
    FormRoot,
    NP_FORM_FIELDS,
    MatButtonModule,
    MatPaginatorModule,
    IconComponent,
    EmptyState,
    PageHeader,
    StatTile,
    InrPipe,
    RewardsNav,
  ],
  templateUrl: './special-rewards.html',
  styleUrl: './special-rewards.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpecialRewards {
  private readonly api = inject(RewardsService);
  private readonly notify = inject(NotificationService);
  protected readonly typeLabel = REWARD_TYPE_LABEL;

  protected readonly overview = rxResource({ stream: () => this.api.overview() });
  protected readonly info = resourceValue(this.overview);
  protected readonly overviewError = resourceError(this.overview, 'Could not load your rewards.');

  protected readonly campaignsRes = rxResource({ stream: () => this.api.campaigns() });
  protected readonly campaigns = resourceValue(this.campaignsRes);
  protected readonly campaignsError = resourceError(this.campaignsRes, 'Could not load current offers.');
  protected readonly claiming = signal<string | null>(null);

  protected readonly filterModel = signal({ rewardType: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly typeOptions: SelectOption[] = [
    { value: '', label: 'All rewards' },
    { value: 'WELCOME', label: 'Welcome' },
    { value: 'BIRTHDAY', label: 'Birthday' },
    { value: 'FESTIVAL', label: 'Festival' },
    { value: 'PROMOTIONAL', label: 'Promotions' },
  ];
  protected readonly history = pagedList(
    (page, limit) =>
      this.api.history({ rewardType: (this.filterModel().rewardType || undefined) as RewardType | undefined, page, limit }),
    { filterKey: () => this.filterModel().rewardType, errorText: 'Could not load your reward history.' },
  );

  // Birthday (set once).
  private readonly today = new Date();
  protected readonly latestBirthDate = new Date(this.today.getFullYear() - 13, this.today.getMonth(), this.today.getDate());
  protected readonly earliestBirthDate = new Date(this.today.getFullYear() - 110, 0, 1);
  protected readonly birthdayModel = signal({ birthDate: null as Date | null });
  protected readonly birthdayForm = form(
    this.birthdayModel,
    (path) => required(path.birthDate, { message: 'Choose your date of birth' }),
    { submission: { action: () => this.saveBirthday() } },
  );
  protected readonly birthdayError = signal<string | null>(null);

  private async saveBirthday(): Promise<TreeValidationResult> {
    this.birthdayError.set(null);
    try {
      await firstValueFrom(this.api.saveBirthday(isoDay(this.birthdayModel().birthDate!)));
      this.notify.success('Birthday saved. We’ll send you a treat on the day!');
      this.overview.reload();
      return undefined;
    } catch (err) {
      const details = fieldErrors(err);
      // Field problems show under the field; anything else (e.g. already saved) above the form.
      if (!details.length) this.birthdayError.set(errorMessage(err));
      return serverErrors(this.birthdayForm, details);
    }
  }

  protected claim(c: CustomerCampaign): void {
    this.claiming.set(c.id);
    this.api.claim(c.id).subscribe({
      next: (claim) => {
        this.claiming.set(null);
        this.notify.success(`${claim.coins} coins added to your wallet`);
        this.campaignsRes.reload();
        this.overview.reload();
        this.history.load(1);
      },
      error: (err: unknown) => {
        this.claiming.set(null);
        this.notify.error(errorMessage(err));
        this.campaignsRes.reload();
      },
    });
  }

  protected upcoming(c: CustomerCampaign): boolean {
    return new Date(c.startAt).getTime() > Date.now();
  }
}
