import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../../environments/environment';
import {
  Commission,
  FinanceDashboard,
  Payout,
  PayoutDue,
  PayoutStatus,
  PayoutType,
  RefundRow,
  Transaction,
} from '../../../shared/models/admin-roles.models';
import { ApiResponse, Paginated } from '../../../shared/models/api.models';
import { toParams } from '../http-params';

@Injectable({ providedIn: 'root' })
export class FinanceService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiUrl}/admin/finance`;

  private get<T>(path: string, query: object = {}): Observable<T> {
    return this.http
      .get<ApiResponse<T>>(`${this.url}/${path}`, { params: toParams(query) })
      .pipe(map((r) => r.data));
  }
  private post<T>(path: string, body: object): Observable<T> {
    return this.http.post<ApiResponse<T>>(`${this.url}/${path}`, body).pipe(map((r) => r.data));
  }

  dashboard = (days: number) => this.get<FinanceDashboard>('dashboard', { days });
  commission = (days: number) => this.get<Commission>('commission', { days });
  transaction = (id: string) =>
    this.get<{ transaction: Transaction }>(`transactions/${id}`).pipe(map((d) => d.transaction));
  refunds = (query: { state?: 'needed' | 'refunded'; page?: number; limit?: number }) =>
    this.get<Paginated<RefundRow>>('refunds', query);

  due = (type: PayoutType) =>
    this.get<{ items: PayoutDue[] }>('payouts/due', { type }).pipe(map((d) => d.items));
  payouts = (query: { type?: PayoutType; status?: PayoutStatus; page?: number; limit?: number }) =>
    this.get<Paginated<Payout>>('payouts', query);
  createPayout = (type: PayoutType, payeeId: string, note?: string) =>
    this.post<{ payout: Payout }>('payouts', { type, payeeId, note }).pipe(map((d) => d.payout));
  markPaid = (id: string, reference: string) =>
    this.post<{ payout: Payout }>(`payouts/${id}/paid`, { reference }).pipe(map((d) => d.payout));
  cancelPayout = (id: string, note?: string) =>
    this.post<{ payout: Payout }>(`payouts/${id}/cancel`, { note }).pipe(map((d) => d.payout));
}
