import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatPaginatorModule } from '@angular/material/paginator';
import { RouterLink } from '@angular/router';
import { IconComponent, SelectOption, ToggleComponent } from 'nexprime';
import { switchMap } from 'rxjs';
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
  AdminReferral,
  REFERRAL_REWARD_LABEL,
  REFERRAL_STATUS_LABEL,
  RISK_LABEL,
  ReferralRewardStatus,
  ReferralStatus,
} from '../../../../shared/models/rewards.models';

/** Referral management: every referral, its risk signals, and approving or rejecting held ones. */
@Component({
  selector: 'bb-reward-referrals',
  imports: [DatePipe, RouterLink, NP_FORM_FIELDS, ToggleComponent, MatButtonModule, MatPaginatorModule, IconComponent, EmptyState, PageHeader],
  templateUrl: './reward-referrals.html',
  styleUrl: './reward-referrals.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RewardReferralsPage {
  private readonly api = inject(AdminRewardsService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);
  protected readonly canManage = inject(AuthService).can('rewards:manage');
  protected readonly statusLabel = REFERRAL_STATUS_LABEL;
  protected readonly rewardLabel = REFERRAL_REWARD_LABEL;
  protected readonly riskLabel = RISK_LABEL;
  protected readonly busy = signal<string | null>(null);
  protected readonly expanded = signal<string | null>(null);

  protected readonly filterModel = signal({ search: '', status: '', rewardStatus: '', flagged: false });
  protected readonly filters = form(this.filterModel);
  protected readonly statusOptions: SelectOption[] = [
    { value: '', label: 'Any stage' },
    ...(['REGISTERED', 'FIRST_ORDER_PLACED', 'ORDER_DELIVERED', 'REWARD_CREDITED', 'REJECTED', 'EXPIRED'] as const).map((s) => ({
      value: s,
      label: REFERRAL_STATUS_LABEL[s],
    })),
  ];
  protected readonly rewardOptions: SelectOption[] = [
    { value: '', label: 'Any reward state' },
    ...Object.entries(REFERRAL_REWARD_LABEL).map(([value, label]) => ({ value, label })),
  ];

  protected readonly list = pagedList(
    (page, limit) => {
      const f = this.filterModel();
      return this.api.referrals({
        search: f.search.trim() || undefined,
        status: (f.status || undefined) as ReferralStatus | undefined,
        rewardStatus: (f.rewardStatus || undefined) as ReferralRewardStatus | undefined,
        flagged: f.flagged || undefined,
        page,
        limit,
      });
    },
    { filterKey: () => JSON.stringify(this.filterModel()), errorText: 'Could not load referrals.' },
  );

  protected showHeld(): void {
    this.filterModel.update((f) => ({ ...f, rewardStatus: 'HELD' }));
  }

  protected toggle(r: AdminReferral): void {
    this.expanded.update((id) => (id === r.id ? null : r.id));
  }

  protected orderNumber(r: AdminReferral): string | null {
    return typeof r.qualifyingOrder === 'object' && r.qualifyingOrder ? r.qualifyingOrder.orderNumber : null;
  }

  protected tone(r: AdminReferral): string {
    if (r.rewardStatus === 'HELD') return 'tone-bad';
    if (r.rewardStatus === 'CREDITED') return 'tone-good';
    if (r.rewardStatus === 'PARTIAL') return 'tone-warn';
    return '';
  }

  protected approve(r: AdminReferral): void {
    confirmed(this.dialog, {
      title: 'Approve and pay this referral?',
      message: `${r.referrer?.name ?? 'The referrer'} and ${r.referred?.name ?? 'the friend'} are paid their referral coins now.`,
      confirmLabel: 'Approve',
      reasonLabel: 'Note for the audit log',
      reasonMax: 300,
    })
      .pipe(
        switchMap((note) => {
          this.busy.set(r.id);
          return this.api.approveReferral(r.id, typeof note === 'string' ? note : undefined);
        }),
      )
      .subscribe(this.done('Referral approved and paid'));
  }

  protected reject(r: AdminReferral): void {
    confirmed(this.dialog, {
      title: 'Reject this referral?',
      message: 'Nobody is paid for it. The customers only see it as "not eligible".',
      confirmLabel: 'Reject',
      danger: true,
      reasonLabel: 'Reason',
      reasonMax: 300,
    })
      .pipe(
        switchMap((note) => {
          this.busy.set(r.id);
          return this.api.rejectReferral(r.id, String(note));
        }),
      )
      .subscribe(this.done('Referral rejected'));
  }

  private done(message: string) {
    return {
      next: () => {
        this.busy.set(null);
        this.notify.success(message);
        this.list.reload();
      },
      error: (err: unknown) => {
        this.busy.set(null);
        this.notify.error(errorMessage(err));
      },
    };
  }
}
