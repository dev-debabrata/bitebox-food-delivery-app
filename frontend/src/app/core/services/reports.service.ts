import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse, Paginated } from '../../shared/models/api.models';
import { PaymentStatus } from '../../shared/models/checkout.models';
import {
  AdminPayment,
  AdminPaymentDetail,
  AdminReport,
  Earnings,
  PaymentInfo,
  PaymentMethod,
  PaymentProvider,
} from '../../shared/models/payment.models';
import { toParams } from './http-params';

export type EarningsScope = 'restaurant' | 'rider';

@Injectable({ providedIn: 'root' })
export class ReportsService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.baseUrl;

  earnings(scope: EarningsScope, days: number): Observable<Earnings> {
    const path = scope === 'restaurant' ? 'my/restaurant/earnings' : 'delivery/earnings';
    return this.http
      .get<ApiResponse<Earnings>>(`${this.api}/${path}`, { params: toParams({ days }) })
      .pipe(map((r) => r.data));
  }

  adminReport(days: number): Observable<AdminReport> {
    return this.http
      .get<ApiResponse<AdminReport>>(`${this.api}/admin/reports`, { params: toParams({ days }) })
      .pipe(map((r) => r.data));
  }

  payments(query: {
    status?: PaymentStatus;
    method?: PaymentMethod;
    provider?: PaymentProvider;
    /** Order number, or the customer's name, email or phone. */
    search?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }): Observable<Paginated<AdminPayment>> {
    return this.http
      .get<ApiResponse<Paginated<AdminPayment>>>(`${this.api}/admin/payments`, {
        params: toParams(query),
      })
      .pipe(map((r) => r.data));
  }

  retryRefund(id: string): Observable<PaymentInfo> {
    return this.http
      .post<ApiResponse<{ payment: PaymentInfo }>>(
        `${this.api}/admin/payments/${encodeURIComponent(id)}/refund`,
        {},
      )
      .pipe(map((r) => r.data.payment));
  }

  /** Django API: one payment with its refunds. */
  payment(id: string): Observable<AdminPaymentDetail> {
    return this.http
      .get<ApiResponse<{ payment: AdminPaymentDetail }>>(`${this.paymentUrl(id)}`)
      .pipe(map((r) => r.data.payment));
  }

  /** Django API: a full or partial refund. `key` makes a retried request safe. */
  refund(id: string, body: { amountPaise: number; reason: string }, key: string) {
    return this.http
      .post<ApiResponse<{ payment: AdminPaymentDetail }>>(`${this.paymentUrl(id)}/refunds`, body, {
        headers: { 'Idempotency-Key': key },
      })
      .pipe(map((r) => r.data.payment));
  }

  /** Django API: a cash refund was paid back by hand. */
  markRefundPaid(refundId: string): Observable<AdminPaymentDetail> {
    return this.http
      .post<ApiResponse<{ payment: AdminPaymentDetail }>>(
        `${this.api}/admin/refunds/${encodeURIComponent(refundId)}/paid`,
        {},
      )
      .pipe(map((r) => r.data.payment));
  }

  private paymentUrl(id: string): string {
    return `${this.api}/admin/payments/${encodeURIComponent(id)}`;
  }
}
