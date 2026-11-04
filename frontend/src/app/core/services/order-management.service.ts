import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse, Paginated } from '../../shared/models/api.models';
import { OrderStatus, VehicleType } from '../../shared/models/checkout.models';
import {
  AdminOrder,
  AdminOrderList,
  AdminRider,
  RestaurantAction,
  RestaurantActiveOrders,
  RestaurantOrder,
  RestaurantOrderHistory,
  RiderAction,
  RiderDashboard,
  RiderOrder,
  RiderProfile,
} from '../../shared/models/order-management.models';
import { toParams } from './http-params';

@Injectable({ providedIn: 'root' })
export class RestaurantOrdersService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiUrl}/my/restaurant/orders`;

  active(): Observable<RestaurantActiveOrders> {
    return this.http
      .get<ApiResponse<RestaurantActiveOrders>>(this.url, { params: toParams({ view: 'active' }) })
      .pipe(map((r) => r.data));
  }

  history(page = 1, limit = 15): Observable<RestaurantOrderHistory> {
    return this.http
      .get<ApiResponse<RestaurantOrderHistory>>(this.url, {
        params: toParams({ view: 'history', page, limit }),
      })
      .pipe(map((r) => r.data));
  }

  setStatus(id: string, status: RestaurantAction, reason?: string): Observable<RestaurantOrder> {
    return this.http
      .patch<ApiResponse<{ order: RestaurantOrder }>>(
        `${this.url}/${encodeURIComponent(id)}/status`,
        { status, reason },
      )
      .pipe(map((r) => r.data.order));
  }
}

@Injectable({ providedIn: 'root' })
export class RiderService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiUrl}/delivery`;

  dashboard(): Observable<RiderDashboard> {
    return this.http.get<ApiResponse<RiderDashboard>>(`${this.url}/me`).pipe(map((r) => r.data));
  }

  saveVehicle(vehicleType: VehicleType, vehicleNumber: string): Observable<RiderProfile> {
    return this.http
      .put<ApiResponse<{ profile: RiderProfile }>>(`${this.url}/me/vehicle`, {
        vehicleType,
        vehicleNumber: vehicleNumber || undefined,
      })
      .pipe(map((r) => r.data.profile));
  }

  goOnline(latitude: number, longitude: number): Observable<RiderDashboard> {
    return this.http
      .patch<ApiResponse<RiderDashboard>>(`${this.url}/me/availability`, {
        isOnline: true,
        latitude,
        longitude,
      })
      .pipe(map((r) => r.data));
  }

  goOffline(): Observable<RiderDashboard> {
    return this.http
      .patch<ApiResponse<RiderDashboard>>(`${this.url}/me/availability`, { isOnline: false })
      .pipe(map((r) => r.data));
  }

  reportLocation(latitude: number, longitude: number): Observable<void> {
    return this.http
      .put<ApiResponse<unknown>>(`${this.url}/me/location`, { latitude, longitude })
      .pipe(map(() => undefined));
  }

  accept(orderId: string): Observable<RiderDashboard> {
    return this.http
      .post<ApiResponse<RiderDashboard>>(
        `${this.url}/offers/${encodeURIComponent(orderId)}/accept`,
        {},
      )
      .pipe(map((r) => r.data));
  }

  decline(orderId: string): Observable<RiderDashboard> {
    return this.http
      .post<ApiResponse<RiderDashboard>>(
        `${this.url}/offers/${encodeURIComponent(orderId)}/decline`,
        {},
      )
      .pipe(map((r) => r.data));
  }

  setStatus(orderId: string, status: RiderAction): Observable<RiderDashboard> {
    return this.http
      .patch<ApiResponse<RiderDashboard>>(
        `${this.url}/orders/${encodeURIComponent(orderId)}/status`,
        { status },
      )
      .pipe(map((r) => r.data));
  }

  history(page = 1, limit = 15): Observable<Paginated<RiderOrder>> {
    return this.http
      .get<ApiResponse<Paginated<RiderOrder>>>(`${this.url}/orders/history`, {
        params: toParams({ page, limit }),
      })
      .pipe(map((r) => r.data));
  }
}

@Injectable({ providedIn: 'root' })
export class AdminOrdersService {
  private readonly http = inject(HttpClient);
  private readonly api = `${environment.apiUrl}/admin`;

  list(query: {
    status?: OrderStatus | 'active';
    search?: string;
    page?: number;
    limit?: number;
  }): Observable<AdminOrderList> {
    return this.http
      .get<ApiResponse<AdminOrderList>>(`${this.api}/orders`, { params: toParams(query) })
      .pipe(map((r) => r.data));
  }

  get(id: string): Observable<AdminOrder> {
    return this.http
      .get<ApiResponse<{ order: AdminOrder }>>(`${this.api}/orders/${encodeURIComponent(id)}`)
      .pipe(map((r) => r.data.order));
  }

  cancel(id: string, reason: string): Observable<AdminOrder> {
    return this.http
      .post<ApiResponse<{ order: AdminOrder }>>(
        `${this.api}/orders/${encodeURIComponent(id)}/cancel`,
        { reason },
      )
      .pipe(map((r) => r.data.order));
  }

  unassign(id: string, reason?: string): Observable<AdminOrder> {
    return this.http
      .post<ApiResponse<{ order: AdminOrder }>>(
        `${this.api}/orders/${encodeURIComponent(id)}/unassign`,
        { reason },
      )
      .pipe(map((r) => r.data.order));
  }

  riders(query: {
    search?: string;
    online?: boolean;
    page?: number;
    limit?: number;
  }): Observable<Paginated<AdminRider>> {
    return this.http
      .get<ApiResponse<Paginated<AdminRider>>>(`${this.api}/delivery-partners`, {
        params: toParams(query),
      })
      .pipe(map((r) => r.data));
  }

  setRiderStatus(id: string, status: 'active' | 'suspended'): Observable<AdminRider['status']> {
    return this.http
      .patch<ApiResponse<{ user: { status: AdminRider['status'] } }>>(
        `${this.api}/delivery-partners/${encodeURIComponent(id)}/status`,
        { status },
      )
      .pipe(map((r) => r.data.user.status));
  }
}
