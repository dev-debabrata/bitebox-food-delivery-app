import { HttpInterceptorFn } from '@angular/common/http';
import { InjectionToken, inject } from '@angular/core';

export const SERVER_API_ORIGIN = new InjectionToken<string>('SERVER_API_ORIGIN');

export const serverApiInterceptor: HttpInterceptorFn = (req, next) => {
  const origin = inject(SERVER_API_ORIGIN, { optional: true });
  return origin && req.url.startsWith('/') ? next(req.clone({ url: origin + req.url })) : next(req);
};
