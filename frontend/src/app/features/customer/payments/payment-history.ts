import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent, PaginationComponent } from 'nexprime';
import { PaymentService } from '../../../core/services/payment.service';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { pagedList } from '../../../shared/list/paged-list';
import {
  PAYMENT_STATUS_LABEL,
  PROVIDER_LABEL,
  REFUND_STATUS_LABEL,
  paymentTone,
} from '../../../shared/models/payment.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';

/** The customer's payments and refunds (`GET /payments/mine`, Django API). */
@Component({
  selector: 'bb-payment-history',
  imports: [
    DatePipe,
    RouterLink,
    IconComponent,
    PaginationComponent,
    EmptyState,
    PageHeader,
    InrPipe,
  ],
  templateUrl: './payment-history.html',
  styleUrl: './payment-history.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PaymentHistory {
  private readonly payments = inject(PaymentService);
  protected readonly statusLabel = PAYMENT_STATUS_LABEL;
  protected readonly providerLabel = PROVIDER_LABEL;
  protected readonly refundLabel = REFUND_STATUS_LABEL;
  protected readonly tone = paymentTone;

  protected readonly list = pagedList((page, limit) => this.payments.history(page, limit), {
    limit: 10,
    errorText: 'Could not load your payments.',
  });
}
