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
  AdminRiderDetail,
  RestaurantAction,
  RestaurantActiveOrders,
  RestaurantOrder,
  RestaurantOrderHistory,
  RiderAction,
  RiderDashboard,
  RiderOrder,
  RiderAddress,
  RiderProfile,
  RiderVerificationStatus,
  RiderStats,
} from '../../shared/models/order-management.models';
import { toParams } from './http-params';

@Injectable({ providedIn: 'root' })
export class RestaurantOrdersService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.baseUrl}/my/restaurant/orders`;

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

  /** `extra.prepMinutes`: with "confirmed", how long the food takes (the Node API ignores it). */
  setStatus(
    id: string,
    status: RestaurantAction,
    extra: { reason?: string; prepMinutes?: number } = {},
  ): Observable<RestaurantOrder> {
    return this.http
      .patch<ApiResponse<{ order: RestaurantOrder }>>(
        `${this.url}/${encodeURIComponent(id)}/status`,
        { status, ...extra },
      )
      .pipe(map((r) => r.data.order));
  }
}

@Injectable({ providedIn: 'root' })
export class RiderService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.baseUrl}/delivery`;

  dashboard(): Observable<RiderDashboard> {
    return this.http.get<ApiResponse<RiderDashboard>>(`${this.url}/me`).pipe(map((r) => r.data));
  }

  /** Today, this week and all-time figures (Django API only: the Node API answers 404). */
  stats(): Observable<RiderStats> {
    return this.http.get<ApiResponse<RiderStats>>(`${this.url}/stats`).pipe(map((r) => r.data));
  }

  saveVehicle(vehicleType: VehicleType, vehicleNumber: string): Observable<RiderProfile> {
    return this.http
      .put<ApiResponse<{ profile: RiderProfile }>>(`${this.url}/me/vehicle`, {
        vehicleType,
        vehicleNumber: vehicleNumber || undefined,
      })
      .pipe(map((r) => r.data.profile));
  }

  /** The home address, needed for verification. */
  saveDetails(address: RiderAddress): Observable<RiderProfile> {
    return this.http
      .patch<ApiResponse<{ profile: RiderProfile }>>(`${this.url}/me/details`, { address })
      .pipe(map((r) => r.data.profile));
  }

  /** After "documents needed" or a rejection: back to the review queue. */
  resubmit(): Observable<RiderProfile> {
    return this.http
      .post<ApiResponse<{ profile: RiderProfile }>>(`${this.url}/me/resubmit`, {})
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

  /** `otp`: the customer's delivery code, with "delivered" when the order needs one. */
  setStatus(orderId: string, status: RiderAction, otp?: string): Observable<RiderDashboard> {
    return this.http
      .patch<ApiResponse<RiderDashboard>>(
        `${this.url}/orders/${encodeURIComponent(orderId)}/status`,
        { status, otp },
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
  private readonly api = `${environment.baseUrl}/admin`;

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

  cancel = (id: string, reason: string) => this.act(id, 'cancel', { reason });
  unassign = (id: string, reason?: string) => this.act(id, 'unassign', { reason });
  /** Manual assignment of a free, online rider (Django API). */
  assign = (id: string, riderId: string) => this.act(id, 'assign', { riderId });
  /** A new delivery code, sent to the customer (Django API). */
  resetDeliveryCode = (id: string) => this.act(id, 'delivery-code', {});

  private act(id: string, action: string, body: object): Observable<AdminOrder> {
    return this.http
      .post<ApiResponse<{ order: AdminOrder }>>(
        `${this.api}/orders/${encodeURIComponent(id)}/${action}`,
        body,
      )
      .pipe(map((r) => r.data.order));
  }

  rider(id: string): Observable<AdminRiderDetail> {
    return this.http
      .get<ApiResponse<AdminRiderDetail>>(`${this.api}/delivery-partners/${encodeURIComponent(id)}`)
      .pipe(map((r) => r.data));
  }

  setRiderVerification(
    id: string,
    status: Exclude<RiderVerificationStatus, 'pending'>,
    reason = '',
  ): Observable<AdminRiderDetail> {
    return this.http
      .patch<ApiResponse<AdminRiderDetail>>(
        `${this.api}/delivery-partners/${encodeURIComponent(id)}/verification`,
        { status, reason },
      )
      .pipe(map((r) => r.data));
  }

  riders(query: {
    search?: string;
    online?: boolean;
    verification?: RiderVerificationStatus;
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
