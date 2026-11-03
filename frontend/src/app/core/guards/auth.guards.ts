import { PLATFORM_ID, inject } from '@angular/core';
import { isPlatformServer } from '@angular/common';
import { toObservable } from '@angular/core/rxjs-interop';
import { CanActivateFn, Router } from '@angular/router';
import { filter, map, take } from 'rxjs';
import { ROLE_META, Role } from '../../shared/models/user.models';
import { AuthService } from '../auth/auth.service';

/**
 * Waits until the startup session restore has finished before deciding.
 * On the server (prerendering) there is never a session, so decide at once.
 */
function whenReady<T>(decide: () => T) {
  const auth = inject(AuthService);
  if (auth.initialised() || isPlatformServer(inject(PLATFORM_ID))) return decide();
  return toObservable(auth.initialised).pipe(
    filter(Boolean),
    take(1),
    map(() => decide()),
  );
}

/**
 * Allows only signed-in users with one of the given roles.
 * - Signed out: redirect to that role's login page with a returnUrl.
 * - Wrong role: redirect to /forbidden.
 *
 * The backend enforces the same rules; this guard only improves UX.
 */
export const roleGuard =
  (...roles: Role[]): CanActivateFn =>
  (_route, state) => {
    const auth = inject(AuthService);
    const router = inject(Router);
    return whenReady(() => {
      const role = auth.role();
      if (!role) {
        return router.createUrlTree([ROLE_META[roles[0]].login], {
          queryParams: { returnUrl: state.url },
        });
      }
      return roles.includes(role) ? true : router.createUrlTree(['/forbidden']);
    });
  };

/** Guests may pass; signed-in users only if `allowed(role)`, otherwise they go to their own home. */
function homeUnless(allowed: (role: Role) => boolean) {
  const auth = inject(AuthService);
  const router = inject(Router);
  return whenReady(() => {
    const role = auth.role();
    return !role || allowed(role) || router.createUrlTree([ROLE_META[role].home]);
  });
}

/** Keeps signed-in users away from login/register pages by sending them to their home. */
export const guestGuard: CanActivateFn = () => homeUnless(() => false);

/** Pages every visitor may see, even staff: error pages. */
const OPEN_TO_ALL = new Set(['forbidden', '**']);

/**
 * The customer site (home, restaurants, checkout, orders…) is for guests and
 * customers. Admins, restaurant partners and riders are sent to their own panel.
 */
export const customerSiteGuard: CanActivateFn = (route) =>
  OPEN_TO_ALL.has(route.routeConfig?.path ?? '') || homeUnless((role) => role === 'customer');
