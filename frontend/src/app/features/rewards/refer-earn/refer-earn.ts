import { DatePipe, isPlatformBrowser } from '@angular/common';
import { ChangeDetectionStrategy, Component, PLATFORM_ID, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatPaginatorModule } from '@angular/material/paginator';
import { IconComponent, SelectOption } from 'nexprime';
import { resourceError, resourceValue } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { RewardsService } from '../../../core/services/rewards.service';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { StatTile } from '../../../shared/components/stat-tile/stat-tile';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { pagedList } from '../../../shared/list/paged-list';
import {
  CustomerReferralStatus,
  REFERRAL_STATUS_LABEL,
  REFERRAL_STEPS,
} from '../../../shared/models/rewards.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';
import { RewardsNav } from '../rewards-nav/rewards-nav';

/** Refer & earn: the customer's code, sharing, statistics and invited friends. */
@Component({
  selector: 'bb-refer-earn',
  imports: [
    DatePipe,
    MatButtonModule,
    MatPaginatorModule,
    IconComponent,
    NP_FORM_FIELDS,
    EmptyState,
    PageHeader,
    StatTile,
    InrPipe,
    RewardsNav,
  ],
  templateUrl: './refer-earn.html',
  styleUrl: './refer-earn.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReferEarn {
  private readonly api = inject(RewardsService);
  private readonly notify = inject(NotificationService);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  protected readonly statusLabel = REFERRAL_STATUS_LABEL;
  protected readonly steps = REFERRAL_STEPS;

  protected readonly referral = rxResource({ stream: () => this.api.referral() });
  protected readonly data = resourceValue(this.referral);
  protected readonly error = resourceError(this.referral, 'Could not load your referral details.');
  protected readonly canShare = this.browser && typeof navigator.share === 'function';

  protected readonly filterModel = signal({ status: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly statusOptions: SelectOption[] = [
    { value: '', label: 'All friends' },
    ...(['REGISTERED', 'FIRST_ORDER_PLACED', 'REWARD_CREDITED', 'EXPIRED', 'NOT_ELIGIBLE'] as const).map((s) => ({
      value: s,
      label: REFERRAL_STATUS_LABEL[s],
    })),
  ];
  protected readonly list = pagedList(
    (page, limit) => this.api.referralHistory({ status: this.filterModel().status || undefined, page, limit }),
    { filterKey: () => this.filterModel().status, errorText: 'Could not load your invited friends.' },
  );

  private shareText(): string {
    const d = this.data();
    if (!d) return '';
    return `Order on BiteBox with my code ${d.code} and get ${d.rules.referredCoins} bonus coins on your first order: ${d.link}`;
  }

  protected async copy(text: string, what: string): Promise<void> {
    if (!this.browser) return;
    try {
      await navigator.clipboard.writeText(text);
      this.notify.success(`${what} copied`);
    } catch {
      this.notify.error(`Could not copy. Select the ${what.toLowerCase()} and copy it instead.`);
    }
  }

  protected async share(): Promise<void> {
    const d = this.data();
    if (!d) return;
    try {
      await navigator.share({ title: 'BiteBox', text: this.shareText(), url: d.link });
    } catch {
      // Closing the share sheet is not an error.
    }
  }

  protected whatsappUrl(): string {
    return `https://wa.me/?text=${encodeURIComponent(this.shareText())}`;
  }

  /** How far along the progress indicator a friend is (0-3), or -1 when it stopped. */
  protected step(status: CustomerReferralStatus): number {
    return this.steps.indexOf(status);
  }

  protected tone(status: CustomerReferralStatus): string {
    if (status === 'REWARD_CREDITED') return 'tone-good';
    if (status === 'EXPIRED' || status === 'NOT_ELIGIBLE') return 'tone-bad';
    return 'tone-warn';
  }
}
