import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { ApiResponse } from '../../../shared/models/api.models';

export interface PromotionInput {
  title: string;
  body: string;
  /** A BiteBox page such as /restaurants (optional). */
  link?: string;
}

/** Promotional push notifications (permission promotions:send). */
@Injectable({ providedIn: 'root' })
export class AdminPushService {
  private readonly http = inject(HttpClient);

  sendPromotion(input: PromotionInput): Observable<{ recipients: number }> {
    return this.http
      .post<ApiResponse<{ recipients: number }>>(`${environment.baseUrl}/admin/push/promotions`, input)
      .pipe(map((r) => r.data));
  }
}
