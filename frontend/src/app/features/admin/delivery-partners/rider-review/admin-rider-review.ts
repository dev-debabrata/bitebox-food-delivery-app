import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { IconComponent } from 'nexprime';
import { errorMessage } from '../../../../core/services/api-error';
import { NotificationService } from '../../../../core/services/notification.service';
import { AdminOrdersService } from '../../../../core/services/order-management.service';
import { confirmed } from '../../../../shared/components/confirm-dialog/confirm-dialog';
import { KycReview } from '../../../../shared/components/kyc/kyc-review/kyc-review';
import { BbDialog } from '../../../../shared/dialog/bb-dialog';
import { VEHICLE_LABEL } from '../../../../shared/models/checkout.models';
import {
  RIDER_VERIFICATION_LABEL,
  RIDER_VERIFICATION_TONE,
  RiderVerificationStatus,
} from '../../../../shared/models/order-management.models';

/** Anything but approving needs a reason, which the rider sees. */
interface Decision {
  status: Exclude<RiderVerificationStatus, 'pending'>;
  label: string;
  message: string;
  danger?: boolean;
}

const APPROVE: Decision = {
  status: 'approved',
  label: 'Approve',
  message: 'The rider can go online and receive deliveries.',
};
const ASK: Decision = {
  status: 'resubmission_requested',
  label: 'Ask for documents',
  message: 'The rider is told what to fix and cannot go online until approved again.',
};
const REJECT: Decision = {
  status: 'rejected',
  label: 'Reject',
  message: 'The rider cannot go online. They see your reason.',
  danger: true,
};
const DECISIONS: Record<RiderVerificationStatus, Decision[]> = {
  pending: [APPROVE, ASK, REJECT],
  resubmission_requested: [APPROVE, REJECT],
  rejected: [APPROVE],
  approved: [ASK],
};

/** One rider: details, verification documents and bank account, and the verification decision. */
@Component({
  selector: 'bb-admin-rider-review',
  imports: [DatePipe, RouterLink, IconComponent, KycReview],
  templateUrl: './admin-rider-review.html',
  styleUrl: './admin-rider-review.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminRiderReview {
  private readonly api = inject(AdminOrdersService);
  private readonly dialog = inject(BbDialog);
  private readonly notify = inject(NotificationService);

  readonly id = input.required<string>();

  protected readonly rider = rxResource({
    params: () => this.id(),
    stream: ({ params }) => this.api.rider(params),
  });
  protected readonly data = computed(() => (this.rider.hasValue() ? this.rider.value() : null));
  protected readonly loadError = computed(() =>
    this.rider.error() ? errorMessage(this.rider.error(), 'Could not load this rider.') : null,
  );
  protected readonly status = computed<RiderVerificationStatus>(
    () => this.data()?.profile.verification?.status ?? 'pending',
  );
  protected readonly decisions = computed(() => DECISIONS[this.status()]);
  protected readonly label = RIDER_VERIFICATION_LABEL;
  protected readonly tone = RIDER_VERIFICATION_TONE;
  protected readonly vehicleLabel = VEHICLE_LABEL;

  protected decide(d: Decision): void {
    const name = this.data()?.user.name ?? 'this rider';
    confirmed(this.dialog, {
      title: `${d.label}: ${name}?`,
      message: d.message,
      confirmLabel: d.label,
      danger: d.danger,
      reasonLabel: d.status === 'approved' ? undefined : 'Reason (shown to the rider)',
    }).subscribe((result) => {
      const reason = typeof result === 'string' ? result : '';
      this.api.setRiderVerification(this.id(), d.status, reason).subscribe({
        next: (detail) => {
          this.rider.set(detail);
          this.notify.success(`${name}: ${RIDER_VERIFICATION_LABEL[d.status]}`);
        },
        error: (err: unknown) => this.notify.error(errorMessage(err)),
      });
    });
  }
}
