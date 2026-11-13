import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormRoot, TreeValidationResult, form, max, min, required } from '@angular/forms/signals';
import { ButtonComponent, IconComponent, SelectOption } from 'nexprime';
import { firstValueFrom, map } from 'rxjs';
import { AuthService } from '../../../../../core/auth/auth.service';
import { AdminCatalogService } from '../../../../../core/services/admin/admin-catalog.service';
import { FinanceService } from '../../../../../core/services/admin/finance.service';
import {
  errorMessage,
  fieldErrors,
  resourceError,
  resourceValue,
} from '../../../../../core/services/api-error';
import { NotificationService } from '../../../../../core/services/notification.service';
import { serverErrors } from '../../../../../shared/forms/form-errors';
import { NP_FORM_FIELDS } from '../../../../../shared/forms/np-form-fields';
import { CommissionRule } from '../../../../../shared/models/admin-roles.models';

const EVERYONE = '';

/**
 * The commission BiteBox takes: one global rate and per-restaurant overrides, with their history.
 * A new rate applies to orders delivered from now on; delivered orders keep the rate they had.
 */
@Component({
  selector: 'bb-commission-rates',
  imports: [DatePipe, FormRoot, NP_FORM_FIELDS, ButtonComponent, IconComponent],
  templateUrl: './commission-rates.html',
  styleUrl: './commission-rates.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommissionRates {
  private readonly api = inject(FinanceService);
  private readonly notify = inject(NotificationService);
  protected readonly canEdit = inject(AuthService).can('payouts:manage');

  protected readonly rules = rxResource({ stream: () => this.api.commissionRules() });
  protected readonly data = resourceValue(this.rules);
  protected readonly loadError = resourceError(this.rules, 'Could not load the commission rates.');
  protected readonly removing = signal<string | null>(null);

  private readonly catalog = inject(AdminCatalogService);
  private readonly restaurants = rxResource({
    stream: () =>
      this.catalog.restaurants({ status: 'approved', limit: 100 }).pipe(map((page) => page.items)),
  });
  protected readonly scopeOptions = computed<SelectOption[]>(() => [
    { value: EVERYONE, label: 'Every restaurant (global rate)' },
    ...(this.restaurants.hasValue() ? this.restaurants.value() : []).map((r) => ({
      value: r.id,
      label: r.name,
    })),
  ]);

  protected readonly model = signal({ scope: EVERYONE, percent: null as number | null, note: '' });
  protected readonly form = form(
    this.model,
    (path) => {
      required(path.percent, { message: 'Enter a percentage' });
      min(path.percent, 0, { message: 'Commission must be between 0 and 50 percent' });
      max(path.percent, 50, { message: 'Commission must be between 0 and 50 percent' });
    },
    { submission: { action: () => this.save() } },
  );

  private async save(): Promise<TreeValidationResult> {
    const { scope, percent, note } = this.model();
    try {
      const rules = await firstValueFrom(
        this.api.setCommission({
          restaurantId: scope || null,
          basisPoints: Math.round(Number(percent) * 100),
          note: note.trim() || undefined,
        }),
      );
      this.rules.set(rules);
      this.form().reset({ scope: EVERYONE, percent: null, note: '' });
      this.notify.success('Commission saved');
      return undefined;
    } catch (err) {
      const fields = fieldErrors(err);
      if (!fields.length) this.notify.error(errorMessage(err));
      return serverErrors(this.form, fields);
    }
  }

  protected remove(rule: CommissionRule): void {
    if (!rule.restaurant) return;
    this.removing.set(rule.id);
    this.api.clearCommission(rule.restaurant.id).subscribe({
      next: (rules) => {
        this.removing.set(null);
        this.rules.set(rules);
        this.notify.success('The global commission applies again');
      },
      error: (err: unknown) => {
        this.removing.set(null);
        this.notify.error(errorMessage(err));
      },
    });
  }
}
