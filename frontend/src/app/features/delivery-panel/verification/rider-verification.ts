import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormRoot, TreeValidationResult, form, pattern, required } from '@angular/forms/signals';
import { IconComponent } from 'nexprime';
import { firstValueFrom } from 'rxjs';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import { KycService } from '../../../core/services/kyc.service';
import { NotificationService } from '../../../core/services/notification.service';
import { RiderService } from '../../../core/services/order-management.service';
import { KycDocuments } from '../../../shared/components/kyc/kyc-documents/kyc-documents';
import { PayoutAccountForm } from '../../../shared/components/kyc/payout-account-form/payout-account-form';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { serverErrors, shownError } from '../../../shared/forms/form-errors';
import { POSTAL_CODE_PATTERN, requiredText } from '../../../shared/forms/form-rules';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { KycSummary } from '../../../shared/models/kyc.models';
import {
  RIDER_VERIFICATION_COPY,
  RIDER_VERIFICATION_LABEL,
  RIDER_VERIFICATION_TONE,
  RiderAddress,
  RiderProfile,
} from '../../../shared/models/order-management.models';

/**
 * What BiteBox needs before a rider goes online: home address, driving licence, vehicle
 * registration, identity proof and the bank account for payouts.
 */
@Component({
  selector: 'bb-rider-verification',
  imports: [FormRoot, NP_FORM_FIELDS, IconComponent, PageHeader, KycDocuments, PayoutAccountForm],
  templateUrl: './rider-verification.html',
  styleUrl: './rider-verification.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RiderVerification {
  private readonly riders = inject(RiderService);
  private readonly kyc = inject(KycService);
  private readonly notify = inject(NotificationService);

  protected readonly profile = signal<RiderProfile | null>(null);
  protected readonly kycData = rxResource({ stream: () => this.kyc.summary() });
  protected readonly summary = computed<KycSummary | null>(() =>
    this.kycData.hasValue() ? this.kycData.value() : null,
  );
  protected readonly status = computed(() => this.profile()?.verification?.status ?? 'pending');
  protected readonly canResubmit = computed(() =>
    ['rejected', 'resubmission_requested'].includes(this.status()),
  );
  protected readonly label = RIDER_VERIFICATION_LABEL;
  protected readonly tone = RIDER_VERIFICATION_TONE;
  protected readonly copy = RIDER_VERIFICATION_COPY;
  protected readonly resubmitting = signal(false);
  protected readonly shownError = shownError;

  protected readonly model = signal({ line1: '', area: '', city: '', state: '', postalCode: '' });
  protected readonly form = form(
    this.model,
    (p) => {
      requiredText(p.line1, 'Street address', { min: 3, max: 120 });
      requiredText(p.city, 'City', { min: 2, max: 60 });
      requiredText(p.state, 'State', { min: 2, max: 60 });
      required(p.postalCode, { message: 'PIN code is required' });
      pattern(p.postalCode, POSTAL_CODE_PATTERN, { message: 'Enter a valid PIN code' });
    },
    { submission: { action: () => this.saveAddress() } },
  );

  constructor() {
    this.riders.dashboard().subscribe({
      next: ({ profile }) => this.profile.set(profile),
      error: (err: unknown) => this.notify.error(errorMessage(err)),
    });
    effect(() => {
      const a = this.profile()?.address;
      if (a && !untracked(() => this.form().dirty()))
        untracked(() => this.form().reset({ ...a, area: a.area ?? '' }));
    });
  }

  private async saveAddress(): Promise<TreeValidationResult> {
    const address = Object.fromEntries(
      Object.entries(this.model())
        .map(([key, value]) => [key, value.trim()])
        .filter(([, value]) => value),
    ) as unknown as RiderAddress;
    try {
      const profile = await firstValueFrom(this.riders.saveDetails(address));
      this.profile.set(profile);
      this.form().reset(this.model());
      this.notify.success('Address saved');
      return undefined;
    } catch (err) {
      const fields = fieldErrors(err);
      if (!fields.length) this.notify.error(errorMessage(err));
      return serverErrors(this.form, fields);
    }
  }

  protected resubmit(): void {
    this.resubmitting.set(true);
    this.riders.resubmit().subscribe({
      next: (profile) => {
        this.resubmitting.set(false);
        this.profile.set(profile);
        this.notify.success('Sent for review. We will let you know soon.');
      },
      error: (err: unknown) => {
        this.resubmitting.set(false);
        this.notify.error(errorMessage(err));
      },
    });
  }
}
