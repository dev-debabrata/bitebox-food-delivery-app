import { HttpClient, type HttpErrorResponse } from '@angular/common/http';
import {
  Injectable,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Observable, catchError, finalize, map, tap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api.models';
import { CartQuote } from '../../shared/models/checkout.models';
import { AuthService } from '../auth/auth.service';
import { DeliveryLocationService } from './delivery-location.service';
import { toParams } from './http-params';

@Injectable({ providedIn: 'root' })
export class CartService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly url = `${environment.apiUrl}/cart`;

  private readonly _quote = signal<CartQuote | null>(null);
  private readonly _busy = signal(false);
  readonly selectedAddressId = signal<string | null>(null);

  readonly quote = this._quote.asReadonly();
  readonly busy = this._busy.asReadonly();
  readonly itemCount = computed(() => this._quote()?.cart?.itemCount ?? 0);
  readonly restaurantId = computed(() => this._quote()?.cart?.restaurant?.id ?? null);
  readonly enabled = computed(() => this.auth.role() === 'customer');

  constructor() {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
    effect(() => {
      const enabled = this.enabled();
      untracked(() => {
        if (enabled) this.refresh().subscribe({ error: () => undefined });
        else {
          this._quote.set(null);
          this.selectedAddressId.set(null);
        }
      });
    });
  }

  quantityOf(foodItemId: string): number {
    return this._quote()?.cart?.items.find((l) => l.foodItemId === foodItemId)?.quantity ?? 0;
  }

  refresh(): Observable<CartQuote> {
    const addressId = this.selectedAddressId();
    return this.load().pipe(
      // A remembered address that isn't on this account (deleted, another account in this
      // browser, reseeded data) gets a 404: forget it and quote the default address instead.
      catchError((err: unknown) => {
        if (!addressId || (err as HttpErrorResponse).status !== 404) return throwError(() => err);
        this.selectedAddressId.set(null);
        this.deliveryLocation.forgetAddress(addressId);
        return this.load();
      }),
    );
  }

  private load(): Observable<CartQuote> {
    return this.http
      .get<ApiResponse<CartQuote>>(this.url, { params: this.addressParams() })
      .pipe(this.apply());
  }

  add(foodItemId: string, quantity = 1, replace = false): Observable<CartQuote> {
    return this.http
      .post<ApiResponse<CartQuote>>(
        `${this.url}/items`,
        { foodItemId, quantity, ...(replace ? { replace } : {}) },
        { params: this.addressParams() },
      )
      .pipe(this.apply());
  }

  setQuantity(foodItemId: string, quantity: number): Observable<CartQuote> {
    return this.http
      .patch<ApiResponse<CartQuote>>(
        `${this.url}/items/${foodItemId}`,
        { quantity },
        { params: this.addressParams() },
      )
      .pipe(this.apply());
  }

  clear(): Observable<CartQuote> {
    return this.http
      .delete<ApiResponse<CartQuote>>(this.url, { params: this.addressParams() })
      .pipe(this.apply());
  }

  applyCoupon(code: string): Observable<CartQuote> {
    return this.http
      .post<ApiResponse<CartQuote>>(
        `${this.url}/coupon`,
        { code },
        { params: this.addressParams() },
      )
      .pipe(this.apply());
  }

  /** Pay part of the order with coins (the server checks and caps the amount). 0 removes them. */
  setCoins(coins: number): Observable<CartQuote> {
    return this.http
      .put<ApiResponse<CartQuote>>(`${this.url}/coins`, { coins }, { params: this.addressParams() })
      .pipe(this.apply());
  }

  removeCoins(): Observable<CartQuote> {
    return this.http
      .delete<ApiResponse<CartQuote>>(`${this.url}/coins`, { params: this.addressParams() })
      .pipe(this.apply());
  }

  removeCoupon(): Observable<CartQuote> {
    return this.http
      .delete<ApiResponse<CartQuote>>(`${this.url}/coupon`, { params: this.addressParams() })
      .pipe(this.apply());
  }

  selectAddress(addressId: string | null): Observable<CartQuote> {
    this.selectedAddressId.set(addressId);
    return this.refresh();
  }

  reset(): void {
    this._quote.set(null);
  }

  private addressParams() {
    return toParams({ addressId: this.selectedAddressId() ?? undefined });
  }

  private apply() {
    this._busy.set(true);
    return (source: Observable<ApiResponse<CartQuote>>) =>
      source.pipe(
        map((res) => res.data),
        tap((quote) => this._quote.set(quote)),
        finalize(() => this._busy.set(false)),
      );
  }
}
