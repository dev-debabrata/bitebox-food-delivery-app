import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormRoot, TreeValidationResult, form, validate } from '@angular/forms/signals';
import { ButtonComponent, IconComponent, SelectOption, ToggleComponent } from 'nexprime';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../../../core/auth/auth.service';
import { AdminRewardsService } from '../../../../core/services/admin/admin-rewards.service';
import { errorCode, errorMessage, fieldErrors } from '../../../../core/services/api-error';
import { NotificationService } from '../../../../core/services/notification.service';
import { PageHeader } from '../../../../shared/components/page-header/page-header';
import { serverErrors } from '../../../../shared/forms/form-errors';
import { numberRange } from '../../../../shared/forms/form-rules';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import {
  EARN_SOURCES,
  RewardConfiguration,
  RewardConfigurationPatch,
  SOURCE_LABEL,
} from '../../../../shared/models/rewards.models';
import { rupeesToPaise } from '../../../../shared/pipes/money.pipes';

/** Number inputs can be empty while editing. */
type Editable<T> = {
  [K in keyof T]: T[K] extends number
    ? number | null
    : T[K] extends readonly unknown[]
      ? T[K]
      : T[K] extends object
        ? Editable<T[K]>
        : T[K];
};
type Settings = Omit<RewardConfiguration, 'version' | 'updatedAt' | 'updatedBy' | 'timezone'>;
/** The editable copy of the settings: money in rupees, payment methods as two switches. */
type Model = Editable<Settings> & { redemption: { cod: boolean; online: boolean } };

/** Settings that hold money: paise in the API, rupees in the form. */
const MONEY_PATHS = [
  ['earning', 'order', 'unitPaise'],
  ['earning', 'order', 'minOrderPaise'],
  ['redemption', 'coinValuePaise'],
  ['redemption', 'minOrderPaise'],
  ['referral', 'minOrderPaise'],
] as const;

function convertMoney(target: object, convert: (value: number) => number): void {
  for (const path of MONEY_PATHS) {
    const parent = path.slice(0, -1).reduce((o: Record<string, unknown>, k) => o[k] as Record<string, unknown>, target as Record<string, unknown>);
    const key = path[path.length - 1];
    parent[key] = convert(Number(parent[key] ?? 0));
  }
}

function toModel(config: RewardConfiguration): Model {
  const { version: _v, updatedAt: _u, updatedBy: _b, timezone: _t, ...settings } = structuredClone(config);
  convertMoney(settings, (paise) => paise / 100);
  const methods = settings.redemption.paymentMethods;
  return {
    ...settings,
    redemption: { ...settings.redemption, cod: methods.includes('cod'), online: methods.includes('online') },
  };
}

function toPatch(model: Model): RewardConfigurationPatch {
  // Empty number inputs are sent as 0 (the server validates every range).
  const settings: Model = JSON.parse(JSON.stringify(model), (_k, v) => (v === null ? 0 : v));
  convertMoney(settings, rupeesToPaise);
  const { cod, online, ...redemption } = settings.redemption;
  return {
    ...(settings as RewardConfigurationPatch),
    redemption: {
      ...(redemption as RewardConfiguration['redemption']),
      paymentMethods: [...(cod ? (['cod'] as const) : []), ...(online ? (['online'] as const) : [])],
    },
  };
}

const REWARD_MAX = 1_000_000;
/** Shape-only stand-in until the real settings load. */
const PLACEHOLDER: RewardConfiguration = {
  version: 0,
  coinsEnabled: false,
  earning: {
    order: { enabled: false, coinsPerUnit: 0, unitPaise: 100, minOrderPaise: 0, maxCoinsPerOrder: 0 },
    review: { enabled: false, coins: 0, minCommentLength: 0 },
  },
  redemption: {
    enabled: false,
    coinValueCoins: 1,
    coinValuePaise: 1,
    minCoins: 1,
    maxCoinsPerOrder: 1,
    maxPercentOfOrder: 1,
    minOrderPaise: 0,
    paymentMethods: [],
  },
  expiry: { enabled: false, days: {}, restoreGraceDays: 0, expiringSoonDays: 1 },
  referral: {
    enabled: false,
    referrerCoins: 0,
    referredCoins: 0,
    minOrderPaise: 0,
    attributionDays: 1,
    maxReferralsPerCustomer: 1,
    maxRewardsPerMonth: 1,
  },
  birthday: { enabled: false, coins: 0 },
  welcome: { enabled: false, coins: 0, trigger: 'registration' },
  timezone: 'Asia/Kolkata',
};
const RUPEES_MAX = 1_000_000;

/** Coins configuration: earning, redemption, expiry, referral, birthday and welcome rules. */
@Component({
  selector: 'bb-rewards-settings',
  imports: [DatePipe, FormRoot, NP_FORM_FIELDS, ToggleComponent, ButtonComponent, IconComponent, PageHeader],
  templateUrl: './rewards-settings.html',
  styleUrl: './rewards-settings.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RewardsSettingsPage {
  private readonly api = inject(AdminRewardsService);
  private readonly notify = inject(NotificationService);
  protected readonly canManage = inject(AuthService).can('rewards:manage');
  protected readonly sources = EARN_SOURCES;
  protected readonly sourceLabel = SOURCE_LABEL;
  protected readonly triggerOptions: SelectOption[] = [
    { value: 'registration', label: 'When they sign up' },
    { value: 'first_order', label: 'When their first order is delivered' },
  ];

  protected readonly loaded = signal<RewardConfiguration | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly saveError = signal<string | null>(null);
  /** Replaced with the real settings on load; the form stays hidden until then. */
  protected readonly model = signal<Model>(toModel(PLACEHOLDER));

  protected readonly form = form(
    this.model,
    (p) => {
      numberRange(p.earning.order.coinsPerUnit, 'Coins per step', 0, REWARD_MAX);
      numberRange(p.earning.order.unitPaise, 'Spend per step', 1, RUPEES_MAX);
      numberRange(p.earning.order.minOrderPaise, 'Minimum order', 0, RUPEES_MAX);
      numberRange(p.earning.order.maxCoinsPerOrder, 'Most coins per order', 0, REWARD_MAX);
      numberRange(p.earning.review.coins, 'Review coins', 0, REWARD_MAX);
      numberRange(p.earning.review.minCommentLength, 'Minimum comment length', 0, 1000);
      numberRange(p.redemption.coinValueCoins, 'Coins', 1, REWARD_MAX);
      numberRange(p.redemption.coinValuePaise, 'Worth', 0.01, RUPEES_MAX);
      numberRange(p.redemption.minCoins, 'Minimum redemption', 1, 10_000_000);
      numberRange(p.redemption.maxCoinsPerOrder, 'Maximum redemption', 1, 10_000_000);
      numberRange(p.redemption.maxPercentOfOrder, 'Share of the order', 1, 100);
      numberRange(p.redemption.minOrderPaise, 'Minimum order', 0, RUPEES_MAX);
      validate(p.redemption.minCoins, ({ value, valueOf }) =>
        (value() ?? 0) > (valueOf(p.redemption.maxCoinsPerOrder) ?? 0)
          ? { kind: 'order', message: 'Cannot be more than the maximum' }
          : undefined,
      );
      validate(p.redemption.online, ({ valueOf }) =>
        valueOf(p.redemption.enabled) && !valueOf(p.redemption.cod) && !valueOf(p.redemption.online)
          ? { kind: 'required', message: 'Allow at least one payment method' }
          : undefined,
      );
      for (const s of EARN_SOURCES) numberRange(p.expiry.days[s], 'Days', 0, 3650);
      numberRange(p.expiry.restoreGraceDays, 'Grace days', 0, 365);
      numberRange(p.expiry.expiringSoonDays, 'Warning days', 1, 365);
      numberRange(p.referral.referrerCoins, 'Referrer coins', 0, REWARD_MAX);
      numberRange(p.referral.referredCoins, 'Friend coins', 0, REWARD_MAX);
      numberRange(p.referral.minOrderPaise, 'Minimum first order', 0, RUPEES_MAX);
      numberRange(p.referral.attributionDays, 'Days to order', 1, 365);
      numberRange(p.referral.maxReferralsPerCustomer, 'Referrals per customer', 1, 100_000);
      numberRange(p.referral.maxRewardsPerMonth, 'Rewards per month', 1, 10_000);
      numberRange(p.birthday.coins, 'Birthday coins', 0, REWARD_MAX);
      numberRange(p.welcome.coins, 'Welcome coins', 0, REWARD_MAX);
    },
    { submission: { action: () => this.save() } },
  );

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loadError.set(null);
    this.api.configuration().subscribe({
      next: (c) => this.reset(c),
      error: (err: unknown) => this.loadError.set(errorMessage(err, 'Could not load the reward settings.')),
    });
  }

  private reset(c: RewardConfiguration): void {
    this.loaded.set(c);
    this.form().reset(toModel(c));
  }

  private async save(): Promise<TreeValidationResult> {
    const current = this.loaded();
    if (!current) return undefined;
    this.saveError.set(null);
    try {
      const saved = await firstValueFrom(this.api.saveConfiguration(current.version, toPatch(this.model())));
      this.notify.success('Reward settings saved');
      this.reset(saved);
      return undefined;
    } catch (err) {
      this.saveError.set(
        errorCode(err) === 'CONFIG_CHANGED'
          ? 'Someone else saved these settings a moment ago. Reload to see their changes, then edit again.'
          : errorMessage(err),
      );
      return serverErrors(this.form, fieldErrors(err));
    }
  }

  protected discard(): void {
    const c = this.loaded();
    if (c) this.reset(c);
  }
}
