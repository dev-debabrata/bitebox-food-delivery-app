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
import { inBackground } from './page-loader';
import { OrderEvent, RealtimeService } from './realtime.service';

export function pollWhileVisible<T>(
  request: () => Observable<T>,
  intervalMs: number,
  document: Document = inject(DOCUMENT),
): Observable<T> {
  const visible = () => document.visibilityState !== 'hidden';
  const becameVisible = fromEvent(document, 'visibilitychange').pipe(filter(visible));
  // Only the first load shows the page loader; repeat polls refresh quietly.
  return merge(
    becameVisible.pipe(map(() => false)),
    timer(intervalMs, intervalMs).pipe(map(() => false), filter(visible)),
  ).pipe(
    startWith(true),
    switchMap((first) => (first ? request() : inBackground(request()))),
  );
}

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
      switchMap(() => inBackground(request())),
    ),
    pollWhileVisible(request, pollMs),
  );
}
