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
import { FormRoot, TreeValidationResult, form, pattern, validate } from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import { ToggleComponent } from 'nexprime';
import { firstValueFrom } from 'rxjs';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import { KycService } from '../../../core/services/kyc.service';
import { MyRestaurantService } from '../../../core/services/my-restaurant.service';
import { NotificationService } from '../../../core/services/notification.service';
import { KycDocuments } from '../../../shared/components/kyc/kyc-documents/kyc-documents';
import { PayoutAccountForm } from '../../../shared/components/kyc/payout-account-form/payout-account-form';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { serverErrors, shownError } from '../../../shared/forms/form-errors';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { Restaurant } from '../../../shared/models/catalog.models';
import { KycSummary } from '../../../shared/models/kyc.models';
import { StatusBanner } from '../status-banner/status-banner';

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * What BiteBox needs before a restaurant goes live: legal and tax details (FSSAI, GST),
 * documents, and the bank account for payouts. After "documents needed", send it for review again.
 */
@Component({
  selector: 'bb-restaurant-verification',
  imports: [
    FormRoot,
    NP_FORM_FIELDS,
    RouterLink,
    ToggleComponent,
    PageHeader,
    StatusBanner,
    KycDocuments,
    PayoutAccountForm,
  ],
  templateUrl: './restaurant-verification.html',
  styleUrl: './restaurant-verification.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RestaurantVerification {
  private readonly restaurants = inject(MyRestaurantService);
  private readonly kyc = inject(KycService);
  private readonly notify = inject(NotificationService);

  protected readonly restaurant = signal<Restaurant | null | undefined>(undefined);
  protected readonly kycData = rxResource({ stream: () => this.kyc.summary() });
  protected readonly summary = computed<KycSummary | null>(() =>
    this.kycData.hasValue() ? this.kycData.value() : null,
  );
  protected readonly canResubmit = computed(() =>
    ['rejected', 'resubmission_requested'].includes(this.restaurant()?.status ?? ''),
  );
  protected readonly resubmitting = signal(false);
  protected readonly shownError = shownError;

  protected readonly model = signal({
    ownerName: '',
    gstRegistered: false,
    gstin: '',
    fssaiNumber: '',
    fssaiValidUntil: null as Date | null,
  });
  protected readonly form = form(
    this.model,
    (p) => {
      pattern(p.fssaiNumber, /^(\d{14})?$/, { message: 'An FSSAI number has 14 digits' });
      validate(p.gstin, ({ value, valueOf }) => {
        const gstin = value().trim().toUpperCase();
        if (valueOf(p.gstRegistered) && !gstin)
          return { kind: 'required', message: 'Enter your GSTIN' };
        return gstin && !GSTIN.test(gstin)
          ? { kind: 'gstin', message: 'Enter a valid 15-character GSTIN' }
          : undefined;
      });
    },
    { submission: { action: () => this.saveLegal() } },
  );

  constructor() {
    this.restaurants.get().subscribe({
      next: ({ restaurant }) => this.restaurant.set(restaurant),
      error: (err: unknown) => {
        this.restaurant.set(null);
        this.notify.error(errorMessage(err));
      },
    });
    effect(() => {
      const r = this.restaurant();
      if (r && !untracked(() => this.form().dirty()))
        untracked(() =>
          this.form().reset({
            ownerName: r.ownerName ?? '',
            gstRegistered: r.gstRegistered ?? false,
            gstin: r.gstin ?? '',
            fssaiNumber: r.fssaiNumber ?? '',
            fssaiValidUntil: r.fssaiValidUntil ? new Date(r.fssaiValidUntil) : null,
          }),
        );
    });
  }

  protected setGst(on: boolean): void {
    this.model.update((m) => ({ ...m, gstRegistered: on }));
    this.form.gstRegistered().markAsDirty();
  }

  private async saveLegal(): Promise<TreeValidationResult> {
    const m = this.model();
    const until = m.fssaiValidUntil;
    try {
      const restaurant = await firstValueFrom(
        this.restaurants.update({
          ownerName: m.ownerName.trim(),
          gstRegistered: m.gstRegistered,
          gstin: m.gstin.trim().toUpperCase(),
          fssaiNumber: m.fssaiNumber.trim(),
          fssaiValidUntil: until
            ? `${until.getFullYear()}-${String(until.getMonth() + 1).padStart(2, '0')}-${String(until.getDate()).padStart(2, '0')}`
            : null,
        }),
      );
      this.restaurant.set(restaurant);
      this.form().reset(this.model());
      this.kycData.reload(); // GST changes which documents are needed
      this.notify.success('Details saved');
      return undefined;
    } catch (err) {
      const fields = fieldErrors(err);
      if (!fields.length) this.notify.error(errorMessage(err));
      return serverErrors(this.form, fields);
    }
  }

  protected resubmit(): void {
    this.resubmitting.set(true);
    this.restaurants.resubmit().subscribe({
      next: (restaurant) => {
        this.resubmitting.set(false);
        this.restaurant.set(restaurant);
        this.notify.success('Sent for review. We will let you know soon.');
      },
      error: (err: unknown) => {
        this.resubmitting.set(false);
        this.notify.error(errorMessage(err));
      },
    });
  }

  protected bankSaved(summary: KycSummary): void {
    this.kycData.set(summary);
  }
}
