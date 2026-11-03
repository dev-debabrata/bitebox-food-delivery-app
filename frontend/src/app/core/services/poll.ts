import { DOCUMENT } from '@angular/common';
import { inject } from '@angular/core';
import {
  Observable,
  debounceTime,
  filter,
  fromEvent,
  map,
  merge,
  startWith,
  switchMap,
  timer,
} from 'rxjs';
import { OrderEvent, RealtimeService } from './realtime.service';

/**
 * Runs `request` now and every `intervalMs` while the tab is visible, and
 * immediately when the user comes back to the tab. Hidden tabs do not poll.
 * Usually combined with live events via `liveRefresh` below.
 * `request` should catch its own errors: an error would end the polling.
 * Unsubscribe (e.g. takeUntilDestroyed) to stop. Pass `document` when not in an injection context.
 */
export function pollWhileVisible<T>(
  request: () => Observable<T>,
  intervalMs: number,
  document: Document = inject(DOCUMENT),
): Observable<T> {
  const visible = () => document.visibilityState !== 'hidden';
  const becameVisible = fromEvent(document, 'visibilitychange').pipe(filter(visible));
  return merge(
    becameVisible.pipe(map(() => 'now')),
    timer(intervalMs, intervalMs).pipe(filter(visible)),
  ).pipe(
    startWith('now'),
    switchMap(() => request()),
  );
}

/**
 * Re-runs `request` whenever a live order event arrives (optionally only matching
 * ones, debounced), with `pollWhileVisible` as the fallback if the socket drops.
 * Call in an injection context. `request` should catch its own errors.
 */
export function liveRefresh<T>(
  request: () => Observable<T>,
  {
    pollMs,
    debounceMs = 250,
    when = () => true,
  }: { pollMs: number; debounceMs?: number; when?: (event: OrderEvent) => boolean },
): Observable<T> {
  return merge(
    inject(RealtimeService).orderUpdates$.pipe(
      filter(when),
      debounceTime(debounceMs),
      switchMap(request),
    ),
    pollWhileVisible(request, pollMs),
  );
}
