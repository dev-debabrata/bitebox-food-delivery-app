import { Injectable, PLATFORM_ID, effect, inject, signal, untracked } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { BehaviorSubject, Observable, Subject, switchMap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';
import { OrderStatus } from '../../shared/models/checkout.models';
import { AppNotification } from '../../shared/models/payment.models';
import { DjangoSocketTransport, RealtimeTransport, SocketIoTransport } from './realtime-transport';

export interface OrderEvent {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  updatedAt: string;
}

export interface RiderLocation {
  orderId: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  at: string;
}

export interface LocationAck {
  ok: boolean;
  error?:
    | 'RATE_LIMITED'
    | 'INVALID_LOCATION'
    | 'IMPRECISE'
    | 'IMPLAUSIBLE'
    | 'OFFLINE'
    | 'SERVER_ERROR'
    | 'NOT_CONNECTED';
}

/** The socket URL for the configured backend (the API's origin; Django serves it at /ws/). */
export function realtimeUrl(): string {
  if (environment.realtime === 'django') {
    const api = new URL(environment.djangoUrl, window.location.origin);
    return `${api.protocol === 'https:' ? 'wss:' : 'ws:'}//${api.host}/ws/`;
  }
  return new URL(environment.baseUrl, window.location.origin).origin;
}

@Injectable({ providedIn: 'root' })
export class RealtimeService {
  private readonly auth = inject(AuthService);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly transport$ = new BehaviorSubject<RealtimeTransport | null>(null);
  private readonly orders = new Subject<OrderEvent>();
  private readonly inbox = new Subject<AppNotification>();
  private retries = 0;

  readonly connected = signal(false);
  readonly orderUpdates$: Observable<OrderEvent> = this.orders.asObservable();
  readonly notifications$: Observable<AppNotification> = this.inbox.asObservable();

  constructor() {
    if (!this.browser) return;
    effect(() => {
      const signedIn = this.auth.user() !== null;
      untracked(() => (signedIn ? this.connect() : this.disconnect()));
    });
  }

  /** Swappable in tests. */
  protected createTransport(): RealtimeTransport {
    const token = () => this.auth.accessToken;
    return environment.realtime === 'django'
      ? new DjangoSocketTransport(realtimeUrl(), token)
      : new SocketIoTransport(realtimeUrl(), token);
  }

  private connect(): void {
    if (this.socket$.value) return;
    const origin = new URL(environment.apiUrl, window.location.origin).origin;
    const socket = io(origin, {
      path: '/socket.io',
      auth: (cb) => cb({ token: this.auth.accessToken }),
      transports: ['websocket', 'polling'],
    });
    this.socket$.next(socket);

    transport.on('connect', () => {
      this.retries = 0;
      this.connected.set(true);
    });
    transport.on('order:updated', (event: OrderEvent) => this.orders.next(event));
    transport.on('notification:new', (n: AppNotification) => this.inbox.next(n));
    transport.on('disconnect', () => this.connected.set(false));
    transport.on('unauthorized', () => {
      this.connected.set(false);
      this.reconnectWithFreshToken();
    });
  }

  private reconnectWithFreshToken(): void {
    const socket = this.socket$.value;
    if (!socket || this.retries >= 5) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.retries++);
    setTimeout(() => {
      if (this.socket$.value !== socket || !this.auth.user()) return;
      this.auth.refresh().subscribe({ next: () => socket.connect(), error: () => undefined });
    }, delay);
  }

  private disconnect(): void {
    this.transport$.value?.close();
    this.transport$.next(null);
    this.connected.set(false);
  }

  track(orderId: string): Observable<RiderLocation> {
    return this.transport$.pipe(
      switchMap(
        (transport) =>
          new Observable<RiderLocation>((subscriber) => {
            if (!transport) return;
            const join = () =>
              transport
                .request<{ ok: boolean; location?: RiderLocation | null }>(
                  'track:join',
                  { orderId },
                  5000,
                )
                .then((ack) => {
                  if (ack.ok && ack.location) subscriber.next(ack.location);
                })
                .catch(() => undefined);
            const onLocation = (location: RiderLocation) => {
              if (location.orderId === orderId) subscriber.next(location);
            };
            transport.on('order:location', onLocation);
            transport.on('connect', join);
            if (transport.isConnected) void join();
            return () => {
              transport.off('order:location', onLocation);
              transport.off('connect', join);
              transport.send('track:leave', { orderId });
            };
          }),
      ),
    );
  }

  async sendRiderLocation(point: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  }): Promise<LocationAck> {
    const transport = this.transport$.value;
    if (!transport?.isConnected) return { ok: false, error: 'NOT_CONNECTED' };
    try {
      return await transport.request<LocationAck>('rider:location', point, 5000);
    } catch {
      return { ok: false, error: 'NOT_CONNECTED' };
    }
  }
}
