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
