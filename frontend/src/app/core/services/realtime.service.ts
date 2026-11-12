import { Injectable, PLATFORM_ID, effect, inject, signal, untracked } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { BehaviorSubject, Observable, Subject, switchMap } from 'rxjs';
import { Socket, io } from 'socket.io-client';
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

@Injectable({ providedIn: 'root' })
export class RealtimeService {
  private readonly auth = inject(AuthService);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly socket$ = new BehaviorSubject<Socket | null>(null);
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

  private connect(): void {
    if (this.transport$.value) return;
    this.retries = 0;
    const transport = this.createTransport();
    this.transport$.next(transport);

    socket.on('connect', () => {
      this.retries = 0;
      this.connected.set(true);
    });
    socket.on('order:updated', (event: OrderEvent) => this.orders.next(event));
    socket.on('notification:new', (n: AppNotification) => this.inbox.next(n));
    socket.on('disconnect', (reason) => {
      this.connected.set(false);
      if (reason === 'io server disconnect') this.reconnectWithFreshToken();
    });
    socket.on('connect_error', () => {
      this.connected.set(false);
      if (!socket.active) this.reconnectWithFreshToken();
    });
  }

  private reconnectWithFreshToken(): void {
    const transport = this.transport$.value;
    if (!transport) return;
    // Out of retries: drop the dead socket, so the next session change (sign-in or a token
    // refresh made by any API call) starts a fresh one instead of finding this one in place.
    if (this.retries >= 5) return this.disconnect();
    const delay = Math.min(30_000, 1000 * 2 ** this.retries++);
    setTimeout(() => {
      if (this.transport$.value !== transport || !this.auth.user()) return;
      this.auth.refresh().subscribe({
        next: () => transport.reconnect(),
        error: () => this.reconnectWithFreshToken(), // e.g. a network blip: back off and retry
      });
    }, delay);
  }

  private disconnect(): void {
    this.socket$.value?.disconnect();
    this.socket$.next(null);
    this.connected.set(false);
  }

  track(orderId: string): Observable<RiderLocation> {
    return this.socket$.pipe(
      switchMap(
        (socket) =>
          new Observable<RiderLocation>((subscriber) => {
            if (!socket) return;
            const join = () =>
              socket
                .timeout(5000)
                .emitWithAck('track:join', { orderId })
                .then((ack: { ok: boolean; location?: RiderLocation | null }) => {
                  if (ack.ok && ack.location) subscriber.next(ack.location);
                })
                .catch(() => undefined);
            const onLocation = (location: RiderLocation) => {
              if (location.orderId === orderId) subscriber.next(location);
            };
            socket.on('order:location', onLocation);
            socket.on('connect', join);
            if (socket.connected) void join();
            return () => {
              socket.off('order:location', onLocation);
              socket.off('connect', join);
              if (socket.connected) socket.emit('track:leave', { orderId });
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
    const socket = this.socket$.value;
    if (!socket?.connected) return { ok: false, error: 'NOT_CONNECTED' };
    try {
      return (await socket.timeout(5000).emitWithAck('rider:location', point)) as LocationAck;
    } catch {
      return { ok: false, error: 'NOT_CONNECTED' };
    }
  }
}
