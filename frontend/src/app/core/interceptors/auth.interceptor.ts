import {
  HttpContext,
  HttpContextToken,
  HttpErrorResponse,
  HttpInterceptorFn,
  HttpRequest,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, switchMap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ROLE_META } from '../../shared/models/user.models';
import { AuthService, isTransient } from '../auth/auth.service';

const NO_RETRY = [
  '/auth/login',
  '/auth/register',
  '/auth/refresh',
  '/auth/logout',
  '/auth/forgot-password',
  '/auth/reset-password',
];

const isApiRequest = (req: HttpRequest<unknown>) => req.url.startsWith(environment.apiUrl);

const PUBLIC_REQUEST = new HttpContextToken<boolean>(() => false);
export const publicRequest = () => new HttpContext().set(PUBLIC_REQUEST, true);

const needsCookies = (req: HttpRequest<unknown>) =>
  req.url.startsWith(`${environment.apiUrl}/auth/`);

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isApiRequest(req)) return next(req);

  if (req.context.get(PUBLIC_REQUEST)) {
    return next(req.clone({ setHeaders: { 'X-Requested-With': 'BiteBox' } }));
  }

  const auth = inject(AuthService);
  const router = inject(Router);

  const withAuth = (token: string | null) =>
    req.clone({
      withCredentials: needsCookies(req),
      setHeaders: {
        'X-Requested-With': 'BiteBox',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

  return next(withAuth(auth.accessToken)).pipe(
    catchError((error: unknown) => {
      const canRetry =
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        auth.accessToken !== null &&
        !NO_RETRY.some((path) => req.url.includes(path));

      if (!canRetry) return throwError(() => error);

      const role = auth.role() ?? 'customer';
      return auth.refresh().pipe(
        switchMap((token) => next(withAuth(token))),
        catchError((refreshError: unknown) => {
          if (!isTransient(refreshError)) {
            void router.navigate([ROLE_META[role].login], {
              queryParams: { returnUrl: router.url, reason: 'expired' },
            });
          }
          return throwError(() => refreshError);
        }),
      );
    }),
  );
};
