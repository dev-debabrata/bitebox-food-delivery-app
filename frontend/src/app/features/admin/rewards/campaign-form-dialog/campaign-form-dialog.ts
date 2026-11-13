import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  FormRoot,
  TreeValidationResult,
  disabled,
  form,
  maxLength,
  validate,
} from '@angular/forms/signals';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent, SelectOption, ToggleComponent } from 'nexprime';
import { firstValueFrom } from 'rxjs';
import { AdminRewardsService } from '../../../../core/services/admin/admin-rewards.service';
import { errorMessage, fieldErrors } from '../../../../core/services/api-error';
import { serverErrors, shownError } from '../../../../shared/forms/form-errors';
import { numberRange, requiredText } from '../../../../shared/forms/form-rules';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import {
  AdminCampaign,
  AdminCampaignInput,
  CUSTOMER_GROUP_LABEL,
  CampaignTrigger,
  CampaignType,
  CustomerGroup,
} from '../../../../shared/models/rewards.models';
import { rupeesToPaise } from '../../../../shared/pipes/money.pipes';

const DAY = 86_400_000;

/** Create or edit a festival / promotional campaign. Running campaigns: wording, end date and limits only. */
@Component({
  selector: 'bb-campaign-form-dialog',
  imports: [FormRoot, NP_FORM_FIELDS, ToggleComponent, MatDialogModule, MatButtonModule, IconComponent],
  templateUrl: './campaign-form-dialog.html',
  styleUrl: './campaign-form-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CampaignFormDialog {
  protected readonly data = inject<AdminCampaign | null>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<CampaignFormDialog, AdminCampaign>);
  private readonly api = inject(AdminRewardsService);
  protected readonly shownError = shownError;
  protected readonly error = signal<string | null>(null);
  /** A running campaign keeps its promise: its reward and rules cannot change. */
  protected readonly running = this.data?.status === 'ACTIVE';

  protected readonly typeOptions: SelectOption[] = [
    { value: 'FESTIVAL', label: 'Festival (Diwali, Holi, New Year…)' },
    { value: 'PROMOTIONAL', label: 'Promotional' },
  ];
  protected readonly triggerOptions: SelectOption[] = [
    { value: 'CLAIM', label: 'Customers tap “Claim”' },
    { value: 'ORDER', label: 'Automatic on a qualifying delivered order' },
  ];
  protected readonly groupOptions: SelectOption[] = Object.entries(CUSTOMER_GROUP_LABEL).map(([value, label]) => ({
    value,
    label,
  }));

  private readonly now = new Date();
  protected readonly model = signal({
    name: this.data?.name ?? '',
    description: this.data?.description ?? '',
    type: (this.data?.type ?? 'FESTIVAL') as string,
    trigger: (this.data?.trigger ?? 'CLAIM') as string,
    rewardCoins: (this.data?.rewardCoins ?? 50) as number | null,
    startAt: new Date(this.data?.startAt ?? this.now) as Date | null,
    endAt: new Date(this.data?.endAt ?? this.now.getTime() + 7 * DAY) as Date | null,
    coinsExpireAt: (this.data?.coinsExpireAt ? new Date(this.data.coinsExpireAt) : null) as Date | null,
    customerGroup: (this.data?.conditions.customerGroup ?? 'ALL') as string,
    inactiveDays: (this.data?.conditions.inactiveDays ?? 30) as number | null,
    minOrder: (this.data ? this.data.conditions.minOrderPaise / 100 : 0) as number | null,
    firstOrderOnly: this.data?.conditions.firstOrderOnly ?? false,
    maxClaimsPerCustomer: (this.data?.limits.maxClaimsPerCustomer ?? 1) as number | null,
    maxTotalClaims: (this.data?.limits.maxTotalClaims ?? null) as number | null,
    maxTotalCoins: (this.data?.limits.maxTotalCoins ?? null) as number | null,
  });

  protected readonly form = form(
    this.model,
    (p) => {
      requiredText(p.name, 'Name', { min: 3, max: 80 });
      maxLength(p.description, 500, { message: 'Keep the description under 500 characters' });
      numberRange(p.rewardCoins, 'Reward', 1, 1_000_000);
      numberRange(p.inactiveDays, 'Inactive days', 1, 3650);
      numberRange(p.minOrder, 'Minimum order', 0, 1_000_000, { optional: true });
      numberRange(p.maxClaimsPerCustomer, 'Claims per customer', 1, 1000);
      numberRange(p.maxTotalClaims, 'Total claims', 1, 10_000_000, { optional: true });
      numberRange(p.maxTotalCoins, 'Coin budget', 1, 1_000_000_000, { optional: true });
      validate(p.startAt, ({ value }) => (value() ? undefined : { kind: 'required', message: 'Choose a start' }));
      validate(p.endAt, ({ value, valueOf }) => {
        const start = valueOf(p.startAt);
        if (!value()) return { kind: 'required', message: 'Choose an end' };
        return start && value()! <= start ? { kind: 'order', message: 'The end must be after the start' } : undefined;
      });
      validate(p.coinsExpireAt, ({ value, valueOf }) => {
        const end = valueOf(p.endAt);
        return value() && end && value()! <= end
          ? { kind: 'order', message: 'Coins must stay valid until after the campaign ends' }
          : undefined;
      });
      const locked = () => this.running;
      disabled(p.type, locked);
      disabled(p.trigger, locked);
      disabled(p.rewardCoins, locked);
      disabled(p.startAt, locked);
      disabled(p.customerGroup, locked);
      disabled(p.inactiveDays, locked);
      disabled(p.minOrder, locked);
      disabled(p.firstOrderOnly, locked);
    },
    { submission: { action: () => this.save() } },
  );

  private async save(): Promise<TreeValidationResult> {
    const v = this.model();
    const limits = {
      maxClaimsPerCustomer: Number(v.maxClaimsPerCustomer),
      maxTotalClaims: v.maxTotalClaims ? Number(v.maxTotalClaims) : null,
      maxTotalCoins: v.maxTotalCoins ? Number(v.maxTotalCoins) : null,
    };
    const coinsExpireAt = v.coinsExpireAt?.toISOString() ?? null;
    const input: Partial<AdminCampaignInput> = this.running
      ? {
          name: v.name.trim(),
          description: v.description.trim(),
          endAt: v.endAt!.toISOString(),
          coinsExpireAt,
          limits,
        }
      : {
          name: v.name.trim(),
          description: v.description.trim(),
          type: v.type as CampaignType,
          trigger: v.trigger as CampaignTrigger,
          rewardCoins: Number(v.rewardCoins),
          startAt: v.startAt!.toISOString(),
          endAt: v.endAt!.toISOString(),
          coinsExpireAt,
          conditions: {
            customerGroup: v.customerGroup as CustomerGroup,
            inactiveDays: Number(v.inactiveDays),
            minOrderPaise: rupeesToPaise(Number(v.minOrder ?? 0)),
            firstOrderOnly: v.firstOrderOnly,
          },
          limits,
        };
    this.error.set(null);
    try {
      this.ref.close(
        await firstValueFrom(
          this.data
            ? this.api.updateCampaign(this.data.id, input)
            : this.api.createCampaign(input as AdminCampaignInput),
        ),
      );
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err));
      return serverErrors(this.form, fieldErrors(err));
    }
  }
}
