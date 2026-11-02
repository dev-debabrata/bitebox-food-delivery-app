import { Injectable, PLATFORM_ID, effect, inject, signal, untracked } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { BehaviorSubject, Observable, Subject, switchMap } from 'rxjs';
import { Socket, io } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';
import { OrderStatus } from '../../shared/models/checkout.models';

/** What the server pushes when an order changes. Details are re-read over the REST API. */
export interface OrderEvent {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  updatedAt: string;
}

/** A rider position pushed while an order is being delivered. `at` is server time. */
export interface RiderLocation {
  orderId: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  at: string;
}

/** Server's answer to a rider position update. */
export interface LocationAck {
  ok: boolean;
  error?: 'RATE_LIMITED' | 'INVALID_LOCATION' | 'IMPRECISE' | 'IMPLAUSIBLE' | 'OFFLINE' | 'SERVER_ERROR' | 'NOT_CONNECTED';
}

/**
 * Live updates over Socket.IO while someone is signed in.
 *
 * The server decides which events each account receives (its own orders,
 * its restaurant, admins see all), so there is nothing to subscribe to here
 * beyond listening. Screens still refresh slowly on their own, so a dropped
 * connection only delays updates; it never loses them.
 */
@Injectable({ providedIn: 'root' })
export class RealtimeService {
  private readonly auth = inject(AuthService);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private socket?: Socket;
  /** The current socket (null while signed out), so listeners can attach whenever it appears. */
  private readonly socket$ = new BehaviorSubject<Socket | null>(null);
  private readonly orders = new Subject<OrderEvent>();
  private retries = 0;

  /** True while the live connection is up. */
  readonly connected = signal(false);
  readonly orderUpdates$: Observable<OrderEvent> = this.orders.asObservable();

  constructor() {
    if (!this.browser) return;
    effect(() => {
      const signedIn = this.auth.user() !== null;
      untracked(() => (signedIn ? this.connect() : this.disconnect()));
    });
  }

  private connect(): void {
    if (this.socket) return;
    // Same host as the API (in development the API runs on its own port).
    const origin = new URL(environment.apiUrl, window.location.origin).origin;
    const socket = io(origin, {
      path: '/socket.io',
      // Read at every (re)connect, so a refreshed token is always used.
      auth: (cb) => cb({ token: this.auth.accessToken }),
      transports: ['websocket', 'polling'],
    });
    this.socket = socket;
    this.socket$.next(socket);

    socket.on('connect', () => {
      this.retries = 0;
      this.connected.set(true);
    });
    socket.on('order:updated', (event: OrderEvent) => this.orders.next(event));
    // The server closes the connection when the access token expires: get a new one and come back.
    socket.on('disconnect', (reason) => {
      this.connected.set(false);
      if (reason === 'io server disconnect') this.reconnectWithFreshToken();
    });
    // Refused at the handshake (usually an expired token): the client does not retry these by itself.
    socket.on('connect_error', () => {
      this.connected.set(false);
      if (!socket.active) this.reconnectWithFreshToken();
    });
  }

  private reconnectWithFreshToken(): void {
    const socket = this.socket;
    if (!socket || this.retries >= 5) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.retries++);
    setTimeout(() => {
      if (this.socket !== socket || !this.auth.user()) return;
      this.auth.refresh().subscribe({ next: () => socket.connect(), error: () => undefined });
    }, delay);
  }

  private disconnect(): void {
    this.socket?.disconnect();
    this.socket = undefined;
    this.socket$.next(null);
    this.connected.set(false);
  }

  /**
   * Live rider positions for one order. The server checks that this account may
   * watch it; the first value (if any) is the last known position, with its time.
   * Re-joins after reconnects; leaves when unsubscribed.
   */
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

  /** Riders: report the device position (the server shares it only with their active order's viewers). */
  async sendRiderLocation(point: { latitude: number; longitude: number; accuracy?: number }): Promise<LocationAck> {
    const socket = this.socket;
    if (!socket?.connected) return { ok: false, error: 'NOT_CONNECTED' };
    try {
      return (await socket.timeout(5000).emitWithAck('rider:location', point)) as LocationAck;
    } catch {
      return { ok: false, error: 'NOT_CONNECTED' };
    }
  }
}
