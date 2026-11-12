import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api.models';

export interface NewsletterResult {
  subscribed: boolean;
  alreadySubscribed: boolean;
}

/** Newsletter sign-up (public). */
@Injectable({ providedIn: 'root' })
export class NewsletterService {
  private readonly http = inject(HttpClient);

  subscribe(email: string): Observable<NewsletterResult> {
    return this.http
      .post<ApiResponse<NewsletterResult>>(`${environment.baseUrl}/newsletter/subscriptions`, { email })
      .pipe(map((r) => r.data));
  }
}
