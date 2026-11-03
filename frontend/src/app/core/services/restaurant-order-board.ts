import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Subscription, catchError, debounceTime, of, tap } from 'rxjs';
import {
  RestaurantActiveOrders,
  RestaurantOrder,
} from '../../shared/models/order-management.models';
import { errorMessage } from './api-error';
import { NotificationService } from './notification.service';
import { RestaurantOrdersService } from './order-management.service';
import { pollWhileVisible } from './poll';
import { RealtimeService } from './realtime.service';

/** Fallback refresh; live Socket.IO events normally update the board within a second. */
const POLL_MS = 60_000;

/**
 * The restaurant's live order board, shared by the panel layout (nav badge,
 * new-order alerts on any page) and the Orders page. Reloads on live Socket.IO
 * events while anything is connected, with a slow poll as a fallback.
 */
@Injectable({ providedIn: 'root' })
export class RestaurantOrderBoard {
  private readonly api = inject(RestaurantOrdersService);
  private readonly notify = inject(NotificationService);
  private readonly document = inject(DOCUMENT);
  private readonly realtime = inject(RealtimeService);

  readonly board = signal<RestaurantActiveOrders | null>(null);
  readonly error = signal<string | null>(null);
  /** The partner has not created their restaurant yet (the API answers 404). */
  readonly noRestaurant = signal(false);
  /** New orders waiting for accept/reject. */
  readonly pendingCount = computed(() => this.board()?.counts.pending ?? 0);

  private connections = 0;
  private polling?: Subscription;
  /** Pending orders already seen, so each new one is announced once. */
  private readonly seen = new Set<string>();
  private primed = false;

  /** Start polling (if not already) for as long as the caller lives. */
  connect(destroyRef: DestroyRef): void {
    if (this.connections++ === 0) {
      this.polling = pollWhileVisible(() => this.fetch(), POLL_MS, this.document).subscribe();
      // Any change to one of our orders (new, cancelled, rider assigned...) reloads the board.
      this.polling.add(
        this.realtime.orderUpdates$.pipe(debounceTime(250)).subscribe(() => this.refresh()),
      );
    }
    destroyRef.onDestroy(() => {
      if (--this.connections === 0) {
        this.polling?.unsubscribe();
        this.polling = undefined;
      }
    });
  }

  /** Reload now (after an action, or the user's refresh button). */
  refresh(): void {
    this.fetch().subscribe();
  }

  /**
   * After our own action: show the updated order at once. The resulting live
   * event reloads the board (counts, tabs); without a live connection, reload now.
   */
  applyChange(order: RestaurantOrder): void {
    this.board.update((b) =>
      b ? { ...b, items: b.items.map((o) => (o.id === order.id ? { ...o, ...order } : o)) } : b,
    );
    if (!this.realtime.connected()) this.refresh();
  }

  private fetch() {
    return this.api.active().pipe(
      tap((data) => this.apply(data)),
      catchError((err: unknown) => {
        if (err instanceof HttpErrorResponse && err.status === 404) this.noRestaurant.set(true);
        else this.error.set(errorMessage(err, 'Could not load orders.'));
        return of(null);
      }),
    );
  }

  private apply(data: RestaurantActiveOrders): void {
    this.error.set(null);
    this.noRestaurant.set(false);
    this.board.set(data);
    const fresh = data.items.filter((o) => o.status === 'pending' && !this.seen.has(o.id));
    fresh.forEach((o) => this.seen.add(o.id));
    // The first load just learns what is already there; only later arrivals are announced.
    if (this.primed && fresh.length) {
      this.notify.info(
        fresh.length === 1 ? `New order ${fresh[0].orderNumber}` : `${fresh.length} new orders`,
      );
      this.chime();
    }
    this.primed = true;
  }

  /** A short two-tone beep. Browsers may block sound until the page has been clicked once. */
  private chime(): void {
    try {
      const AudioCtx = this.document.defaultView?.AudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      [880, 1175].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.18);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.16);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.18);
        osc.stop(ctx.currentTime + i * 0.18 + 0.17);
      });
      setTimeout(() => void ctx.close(), 600);
    } catch {
      // Sound is a nicety; the on-screen alert is what matters.
    }
  }
}
