import { DOCUMENT } from '@angular/common';
import { inject } from '@angular/core';
import { Observable, filter, fromEvent, map, merge, startWith, switchMap, timer } from 'rxjs';

/**
 * Runs `request` now and every `intervalMs` while the tab is visible, and
 * immediately when the user comes back to the tab. Hidden tabs do not poll.
 * (Phase 4 refreshes order boards this way; Phase 5 adds live Socket.IO events.)
 * `request` should catch its own errors: an error would end the polling.
 * Unsubscribe (e.g. takeUntilDestroyed) to stop. Pass `document` when not in an injection context.
 */
export function pollWhileVisible<T>(request: () => Observable<T>, intervalMs: number, document: Document = inject(DOCUMENT)): Observable<T> {
  const visible = () => document.visibilityState !== 'hidden';
  const becameVisible = fromEvent(document, 'visibilitychange').pipe(filter(visible));
  return merge(becameVisible.pipe(map(() => 'now')), timer(intervalMs, intervalMs).pipe(filter(visible))).pipe(
    startWith('now'),
    switchMap(() => request()),
  );
}
