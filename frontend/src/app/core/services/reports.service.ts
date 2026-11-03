import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse, Paginated } from '../../shared/models/api.models';
import { PaymentStatus } from '../../shared/models/checkout.models';
import {
  AdminPayment,
  AdminReport,
  Earnings,
  PaymentInfo,
  PaymentMethod,
  PaymentProvider,
} from '../../shared/models/payment.models';
import { toParams } from './http-params';

/** Who is asking for earnings: the restaurant owner or the rider (scope comes from the session). */
export type EarningsScope = 'restaurant' | 'rider';

/** Earnings, platform reports and payment administration. */
@Injectable({ providedIn: 'root' })
export class ReportsService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  earnings(scope: EarningsScope, days: number): Observable<Earnings> {
    const path = scope === 'restaurant' ? 'my/restaurant/earnings' : 'delivery/earnings';
    return this.http.get<ApiResponse<Earnings>>(`${this.api}/${path}`, { params: toParams({ days }) }).pipe(map((r) => r.data));
  }

  adminReport(days: number): Observable<AdminReport> {
    return this.http.get<ApiResponse<AdminReport>>(`${this.api}/admin/reports`, { params: toParams({ days }) }).pipe(map((r) => r.data));
  }

  payments(query: {
    status?: PaymentStatus;
    method?: PaymentMethod;
    provider?: PaymentProvider;
    page?: number;
    limit?: number;
  }): Observable<Paginated<AdminPayment>> {
    return this.http.get<ApiResponse<Paginated<AdminPayment>>>(`${this.api}/admin/payments`, { params: toParams(query) }).pipe(map((r) => r.data));
  }

  retryRefund(id: string): Observable<PaymentInfo> {
    return this.http
      .post<ApiResponse<{ payment: PaymentInfo }>>(`${this.api}/admin/payments/${encodeURIComponent(id)}/refund`, {})
      .pipe(map((r) => r.data.payment));
  }
}
