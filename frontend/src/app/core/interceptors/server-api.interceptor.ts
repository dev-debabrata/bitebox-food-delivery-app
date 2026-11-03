import { HttpInterceptorFn } from '@angular/common/http';
import { InjectionToken, inject } from '@angular/core';

/**
 * Server rendering only: where the API is reachable from the web server itself
 * (e.g. "http://api:5000" in Docker), from API_INTERNAL_URL. Not provided in the browser.
 */
export const SERVER_API_ORIGIN = new InjectionToken<string>('SERVER_API_ORIGIN');

/**
 * In production the browser calls the API on the same origin ("/api/v1/…", via the reverse
 * proxy). The server has no browser origin, so during rendering those calls go to the
 * internal API address instead. Runs after Angular's transfer cache, which keeps keying
 * responses by the original "/api/…" URL, so the browser reuses them on hydration.
 */
export const serverApiInterceptor: HttpInterceptorFn = (req, next) => {
  const origin = inject(SERVER_API_ORIGIN, { optional: true });
  return origin && req.url.startsWith('/') ? next(req.clone({ url: origin + req.url })) : next(req);
};
