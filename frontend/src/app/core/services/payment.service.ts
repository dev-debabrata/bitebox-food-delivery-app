import { HttpClient } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Observable, firstValueFrom, map, shareReplay } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api.models';
import {
  CheckoutSession,
  PaymentInfo,
  PaymentMethodOption,
} from '../../shared/models/payment.models';
import { MockPaymentDialog } from '../../shared/components/mock-payment-dialog/mock-payment-dialog';
import { publicRequest } from '../interceptors/auth.interceptor';

const RAZORPAY_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

interface RazorpayResult {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}
type RazorpayCtor = new (options: Record<string, unknown>) => { open(): void };

/** Customer payment steps for online orders (cash on delivery needs none). */
@Injectable({ providedIn: 'root' })
export class PaymentService {
  private readonly http = inject(HttpClient);
  private readonly dialog = inject(MatDialog);
  private readonly document = inject(DOCUMENT);
  private readonly url = `${environment.apiUrl}/payments`;
  private razorpay?: Promise<RazorpayCtor>;

  /** What checkout offers (cached for the session). */
  readonly methods$: Observable<PaymentMethodOption[]> = this.http
    .get<ApiResponse<{ methods: PaymentMethodOption[] }>>(`${this.url}/methods`, { context: publicRequest() })
    .pipe(
      map((r) => r.data.methods),
      shareReplay({ bufferSize: 1, refCount: false }),
    );

  start(orderId: string): Observable<CheckoutSession> {
    return this.http
      .post<ApiResponse<{ checkout: CheckoutSession }>>(`${this.orderUrl(orderId)}/start`, {})
      .pipe(map((r) => r.data.checkout));
  }

  /** Closed the payment page at checkout: cancel the unpaid order and put its dishes back in the cart. */
  abandon(orderId: string): Observable<{ restored: boolean }> {
    return this.http
      .post<ApiResponse<{ restored: boolean }>>(`${this.orderUrl(orderId)}/abandon`, {})
      .pipe(map((r) => r.data));
  }

  /**
   * Opens the gateway for `session` and reports the result to the server.
   * Resolves with the payment state, or null when the customer closed the
   * checkout without paying. Rejects on a network or verification error.
   */
  async pay(orderId: string, session: CheckoutSession): Promise<PaymentInfo | null> {
    if (session.provider === 'mock') {
      const outcome = await firstValueFrom(
        this.dialog
          .open<MockPaymentDialog, CheckoutSession, 'success' | 'failure'>(MockPaymentDialog, {
            data: session,
            width: '440px',
            maxWidth: '95vw',
            panelClass: 'bb-gateway-dialog',
            autoFocus: false,
          })
          .afterClosed(),
      );
      return outcome ? this.post(orderId, 'mock', { outcome }) : null;
    }
    const result = await this.openRazorpay(session);
    return result
      ? this.post(orderId, 'confirm', { providerPaymentId: result.razorpay_payment_id, signature: result.razorpay_signature })
      : null;
  }

  private post(orderId: string, step: 'mock' | 'confirm', body: object): Promise<PaymentInfo> {
    return firstValueFrom(
      this.http
        .post<ApiResponse<{ payment: PaymentInfo }>>(`${this.orderUrl(orderId)}/${step}`, body)
        .pipe(map((r) => r.data.payment)),
    );
  }

  private orderUrl(orderId: string): string {
    return `${this.url}/orders/${encodeURIComponent(orderId)}`;
  }

  private async openRazorpay(session: CheckoutSession): Promise<RazorpayResult | null> {
    const Razorpay = await this.loadRazorpay();
    return new Promise((resolve) => {
      new Razorpay({
        key: session.keyId,
        order_id: session.providerOrderId,
        amount: session.amountPaise,
        currency: session.currency,
        name: 'BiteBox',
        description: `Order ${session.orderNumber}`,
        theme: { color: '#2e1a3d' },
        handler: (result: RazorpayResult) => resolve(result),
        modal: { ondismiss: () => resolve(null) },
      }).open();
    });
  }

  /** Razorpay's checkout script, loaded once on first use. */
  private loadRazorpay(): Promise<RazorpayCtor> {
    const win = this.document.defaultView as (Window & { Razorpay?: RazorpayCtor }) | null;
    if (win?.Razorpay) return Promise.resolve(win.Razorpay);
    this.razorpay ??= new Promise<RazorpayCtor>((resolve, reject) => {
      const script = this.document.createElement('script');
      script.src = RAZORPAY_SCRIPT;
      script.onload = () => (win?.Razorpay ? resolve(win.Razorpay) : reject(new Error('Razorpay unavailable')));
      script.onerror = () => {
        this.razorpay = undefined;
        script.remove();
        reject(new Error('Could not load the payment page. Check your connection and try again.'));
      };
      this.document.head.appendChild(script);
    });
    return this.razorpay;
  }
}
