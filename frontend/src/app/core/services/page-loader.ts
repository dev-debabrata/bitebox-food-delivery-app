import { isPlatformBrowser } from '@angular/common';
import { HttpInterceptorFn } from '@angular/common/http';
import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { Observable, defer, finalize } from 'rxjs';

/** Requests faster than this never show the bar, so quick calls don't flicker. */
const SHOW_AFTER_MS = 200;
let quiet = 0;

/**
 * Subscribes without showing the page loader (polls, live refreshes). HttpClient runs its
 * interceptors synchronously on subscribe, so the interceptor sees the flag.
 */
export const inBackground = <T>(source: Observable<T>): Observable<T> =>
  new Observable<T>((subscriber) => {
    quiet++;
    try {
      return source.subscribe(subscriber);
    } finally {
      quiet--;
    }
  });

/** Counts API calls in flight; `visible` turns on once one has been pending for a moment. */
@Injectable({ providedIn: 'root' })
export class PageLoader {
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly _visible = signal(false);
  readonly visible = this._visible.asReadonly();
  private pending = 0;
  private timer?: ReturnType<typeof setTimeout>;

  track<T>(request$: Observable<T>): Observable<T> {
    if (!this.browser || quiet) return request$;
    return defer(() => {
      if (this.pending++ === 0) this.timer = setTimeout(() => this._visible.set(true), SHOW_AFTER_MS);
      return request$.pipe(
        finalize(() => {
          if (--this.pending) return;
          clearTimeout(this.timer);
          this._visible.set(false);
        }),
      );
    });
  }
}

export const pageLoaderInterceptor: HttpInterceptorFn = (req, next) =>
  inject(PageLoader).track(next(req));
