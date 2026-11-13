import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { FileDownloadService } from './file-download.service';
import { environment } from '../../../environments/environment';
import { ApiResponse, Paginated } from '../../shared/models/api.models';
import {
  AddressInput,
  AdminCoupon,
  AdminCouponInput,
  CouponOffer,
  DeliveryAddress,
  Order,
} from '../../shared/models/checkout.models';
import { CheckoutSession, PaymentMethod } from '../../shared/models/payment.models';
import { toParams } from './http-params';

@Injectable({ providedIn: 'root' })
export class AddressService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.baseUrl}/addresses`;

  list(): Observable<DeliveryAddress[]> {
    return this.http
      .get<ApiResponse<{ addresses: DeliveryAddress[] }>>(this.url)
      .pipe(map((r) => r.data.addresses));
  }

  create(input: AddressInput): Observable<DeliveryAddress> {
    return this.http
      .post<ApiResponse<{ address: DeliveryAddress }>>(this.url, input)
      .pipe(map((r) => r.data.address));
  }

  update(id: string, input: Partial<AddressInput>): Observable<DeliveryAddress> {
    return this.http
      .patch<ApiResponse<{ address: DeliveryAddress }>>(`${this.url}/${id}`, input)
      .pipe(map((r) => r.data.address));
  }

  setDefault(id: string): Observable<DeliveryAddress> {
    return this.http
      .patch<ApiResponse<{ address: DeliveryAddress }>>(`${this.url}/${id}/default`, {})
      .pipe(map((r) => r.data.address));
  }

  remove(id: string): Observable<void> {
    return this.http.delete<ApiResponse<null>>(`${this.url}/${id}`).pipe(map(() => undefined));
  }
}

export interface PlaceOrderRequest {
  addressId: string;
  paymentMethod: PaymentMethod;
  note?: string;
  expectedTotalPaise: number;
}

@Injectable({ providedIn: 'root' })
export class OrderService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.baseUrl;
  private readonly files = inject(FileDownloadService);

  /** The PDF invoice of a delivered order. */
  invoice(orderId: string): Promise<void> {
    return this.files.save(
      `${this.api}/orders/${encodeURIComponent(orderId)}/invoice`,
      'BiteBox-invoice.pdf',
    );
  }

  place(
    request: PlaceOrderRequest,
    idempotencyKey: string,
  ): Observable<{ order: Order; checkout: CheckoutSession | null }> {
    return this.http
      .post<ApiResponse<{ order: Order; checkout?: CheckoutSession | null }>>(
        `${this.api}/orders`,
        request,
        {
          headers: new HttpHeaders({ 'Idempotency-Key': idempotencyKey }),
        },
      )
      .pipe(map((r) => ({ order: r.data.order, checkout: r.data.checkout ?? null })));
  }

  mine(page = 1, limit = 10): Observable<Paginated<Order>> {
    return this.http
      .get<ApiResponse<Paginated<Order>>>(`${this.api}/orders`, {
        params: toParams({ page, limit }),
      })
      .pipe(map((r) => r.data));
  }

  get(id: string): Observable<Order> {
    return this.http
      .get<ApiResponse<{ order: Order }>>(`${this.api}/orders/${encodeURIComponent(id)}`)
      .pipe(map((r) => r.data.order));
  }

  cancel(id: string, reason?: string): Observable<Order> {
    return this.http
      .post<ApiResponse<{ order: Order }>>(`${this.api}/orders/${encodeURIComponent(id)}/cancel`, {
        reason,
      })
      .pipe(map((r) => r.data.order));
  }

  availableCoupons(restaurantId?: string): Observable<CouponOffer[]> {
    return this.http
      .get<ApiResponse<{ coupons: CouponOffer[] }>>(`${this.api}/coupons/available`, {
        params: toParams({ restaurantId }),
      })
      .pipe(map((r) => r.data.coupons));
  }
}

@Injectable({ providedIn: 'root' })
export class AdminCouponService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.baseUrl}/admin/coupons`;

  list(query: {
    search?: string;
    active?: boolean;
    page?: number;
    limit?: number;
  }): Observable<Paginated<AdminCoupon>> {
    return this.http
      .get<ApiResponse<Paginated<AdminCoupon>>>(this.url, { params: toParams(query) })
      .pipe(map((r) => r.data));
  }

  create(input: AdminCouponInput): Observable<AdminCoupon> {
    return this.http
      .post<ApiResponse<{ coupon: AdminCoupon }>>(this.url, input)
      .pipe(map((r) => r.data.coupon));
  }

  update(id: string, input: AdminCouponInput): Observable<AdminCoupon> {
    return this.http
      .patch<ApiResponse<{ coupon: AdminCoupon }>>(`${this.url}/${id}`, input)
      .pipe(map((r) => r.data.coupon));
  }

  remove(id: string): Observable<void> {
    return this.http.delete<ApiResponse<null>>(`${this.url}/${id}`).pipe(map(() => undefined));
  }
}
