import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api.models';
import { OrderStatus } from '../../shared/models/checkout.models';
import { inBackground } from './page-loader';

/** `GET /tracking/orders/:id`: where the delivery is, for restoring the map after a reconnect. */
export interface OrderTrackingState {
  orderId: string;
  status: OrderStatus;
  tracking: boolean;
  lastPoint: { latitude: number; longitude: number; accuracy: number | null; at: string } | null;
  ageSeconds: number | null;
  stale: boolean;
  /** The delivery's recent path, oldest first, as [latitude, longitude]. */
  recentPath: [number, number][];
}

@Injectable({ providedIn: 'root' })
export class OrderTrackingService {
  private readonly http = inject(HttpClient);

  /** Null when it can't be loaded (the live socket still works without it). */
  get(orderId: string): Observable<OrderTrackingState | null> {
    return inBackground(
      this.http.get<ApiResponse<OrderTrackingState>>(
        `${environment.baseUrl}/tracking/orders/${encodeURIComponent(orderId)}`,
      ),
    ).pipe(
      map((r) => r.data),
      catchError(() => of(null)),
    );
  }
}
