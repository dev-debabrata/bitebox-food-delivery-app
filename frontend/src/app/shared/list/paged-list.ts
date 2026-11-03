import { DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { PageEvent } from '@angular/material/paginator';
import { EMPTY, Observable, catchError, debounceTime, distinctUntilChanged, skip, tap } from 'rxjs';
import { errorMessage } from '../../core/services/api-error';
import { liveRefresh } from '../../core/services/poll';
import { OrderEvent } from '../../core/services/realtime.service';

/**
 * State for a paginated list page: loads `fetch(page, limit)`. With `pollMs` it
 * also reloads on live order events (`when`), polling as a fallback; with
 * `filterKey` it goes back to page 1 (debounced) whenever that changes.
 * Call in an injection context (component constructor / field initialiser).
 */
export function pagedList<T>(
  fetch: (page: number, limit: number) => Observable<T>,
  opts: {
    filterKey?: () => string;
    pollMs?: number;
    when?: (event: OrderEvent) => boolean;
    limit?: number;
    /** Don't load until `load(1)` is called (e.g. a tab that may never be opened). */
    lazy?: boolean;
    errorText: string;
  },
) {
  const destroyRef = inject(DestroyRef);
  const data = signal<T | null>(null);
  const loading = signal(true);
  const error = signal<string | null>(null);
  let page = 1;
  let limit = opts.limit ?? 20;

  const request = () => {
    loading.set(true);
    return fetch(page, limit).pipe(
      tap((d) => {
        data.set(d);
        error.set(null);
        loading.set(false);
      }),
      catchError((err: unknown) => {
        error.set(errorMessage(err, opts.errorText));
        loading.set(false);
        return EMPTY;
      }),
    );
  };
  const load = (p: number) => {
    page = p;
    request().subscribe();
  };

  if (opts.pollMs) {
    liveRefresh(request, { pollMs: opts.pollMs, debounceMs: 1000, when: opts.when })
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe();
  } else if (!opts.lazy) {
    load(1);
  }
  if (opts.filterKey) {
    toObservable(computed(opts.filterKey))
      .pipe(skip(1), debounceTime(300), distinctUntilChanged(), takeUntilDestroyed(destroyRef))
      .subscribe(() => load(1));
  }

  return {
    data: data.asReadonly(),
    loading: loading.asReadonly(),
    error: error.asReadonly(),
    load,
    reload: () => load(page),
    onPage: (event: PageEvent) => {
      limit = event.pageSize;
      load(event.pageIndex + 1);
    },
  };
}
