import { DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { PageEvent } from '@angular/material/paginator';
import { EMPTY, Observable, catchError, debounceTime, finalize, skip, tap } from 'rxjs';
import { errorMessage } from '../../core/services/api-error';
import { liveRefresh } from '../../core/services/poll';
import { OrderEvent } from '../../core/services/realtime.service';

export function pagedList<T extends { items: readonly unknown[] }>(
  fetch: (page: number, limit: number) => Observable<T>,
  opts: {
    filterKey?: () => string;
    pollMs?: number;
    when?: (event: OrderEvent) => boolean;
    limit?: number;
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
  let latest = 0;

  // Only the newest request may write, so a slow response for old filters can't replace newer data.
  const request = () => {
    const id = ++latest;
    const current = () => id === latest;
    loading.set(true);
    return fetch(page, limit).pipe(
      tap((d) => current() && (data.set(d), error.set(null))),
      catchError((err: unknown) => {
        if (current()) error.set(errorMessage(err, opts.errorText));
        return EMPTY;
      }),
      finalize(() => current() && loading.set(false)),
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
      .pipe(
        skip(1),
        // Loading starts now, not after the debounce, so the old results never read as "no matches".
        tap(() => loading.set(true)),
        debounceTime(300),
        takeUntilDestroyed(destroyRef),
      )
      .subscribe(() => load(1));
  }

  /** Nothing to show yet: first load, or a reload where the old page was empty anyway. */
  const showSkeleton = computed(() => !data()?.items.length && (loading() || !data()));

  return {
    data: data.asReadonly(),
    loading: loading.asReadonly(),
    showSkeleton,
    /** Loaded, and nothing matches. */
    empty: computed(() => !showSkeleton() && !data()?.items.length),
    error: error.asReadonly(),
    load,
    reload: () => load(page),
    /** Drops the current page, e.g. on a tab switch where the old rows belong to another list. */
    clear: () => data.set(null),
    onPage: (event: PageEvent) => {
      limit = event.pageSize;
      load(event.pageIndex + 1);
    },
    /** For np-pagination: `(pageChange)` → goTo(page); `(rowsChange)` → goTo(1, rows). */
    goTo: (nextPage: number, rows?: number) => {
      if (rows) limit = rows;
      load(nextPage);
    },
  };
}
