import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse, Pagination } from '../../shared/models/api.models';
import { toParams } from './http-params';

export type NotificationCategory = 'orders' | 'account' | 'promotions';
export type NotificationChannel = 'push' | 'email' | 'sms';
type Switches = Record<NotificationCategory, boolean>;

/** `GET /notifications/preferences`: each channel's switches and what can be used right now. */
export interface ChannelPreferences {
  channels: Record<NotificationChannel, Switches>;
  categories: NotificationCategory[];
  available: Record<NotificationChannel, boolean>;
}

@Injectable({ providedIn: 'root' })
export class NotificationPreferencesService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.baseUrl}/notifications/preferences`;

  get(): Observable<ChannelPreferences> {
    return this.http.get<ApiResponse<ChannelPreferences>>(this.url).pipe(map((r) => r.data));
  }

  /** Send only the switches that change, e.g. `{ sms: { orders: true } }`. */
  update(
    changes: Partial<Record<NotificationChannel, Partial<Switches>>>,
  ): Observable<ChannelPreferences> {
    return this.http
      .put<ApiResponse<ChannelPreferences>>(this.url, changes)
      .pipe(map((r) => r.data));
  }
}

export type DeliveryStatus = 'queued' | 'sent' | 'failed' | 'dead' | 'skipped';
export type DeliveryChannel = 'push' | 'fcm' | 'email' | 'sms';

/** One notification on one external channel (`GET /admin/notifications/deliveries`). */
export interface NotificationDelivery {
  id: string;
  channel: DeliveryChannel;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
  createdAt: string;
  notification: { id: string; type: string; title: string } | null;
  user: { id: string; name: string; email: string } | null;
}

export interface DeliveryLog {
  items: NotificationDelivery[];
  pagination: Pagination;
  counts: Partial<Record<DeliveryStatus, number>>;
}

/** Admin: the notification delivery log and retries (`operations:view`). */
@Injectable({ providedIn: 'root' })
export class NotificationDeliveriesService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.baseUrl}/admin/notifications/deliveries`;

  list(query: {
    status?: DeliveryStatus;
    channel?: DeliveryChannel;
    page?: number;
    limit?: number;
  }): Observable<DeliveryLog> {
    return this.http
      .get<ApiResponse<DeliveryLog>>(this.url, { params: toParams(query) })
      .pipe(map((r) => r.data));
  }

  retry(id: string): Observable<NotificationDelivery> {
    return this.http
      .post<ApiResponse<{ delivery: NotificationDelivery }>>(
        `${this.url}/${encodeURIComponent(id)}/retry`,
        {},
      )
      .pipe(map((r) => r.data.delivery));
  }
}
