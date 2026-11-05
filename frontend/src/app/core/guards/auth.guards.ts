import { PLATFORM_ID, inject } from '@angular/core';
import { isPlatformServer } from '@angular/common';
import { toObservable } from '@angular/core/rxjs-interop';
import { CanActivateFn, Router } from '@angular/router';
import { filter, map, take } from 'rxjs';
import { Permission, ROLE_META, Role } from '../../shared/models/user.models';
import { AuthService } from '../auth/auth.service';

function whenReady<T>(decide: () => T) {
  const auth = inject(AuthService);
  if (auth.initialised() || isPlatformServer(inject(PLATFORM_ID))) return decide();
  return toObservable(auth.initialised).pipe(
    filter(Boolean),
    take(1),
    map(() => decide()),
  );
}

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

function homeUnless(allowed: (role: Role) => boolean) {
  const auth = inject(AuthService);
  const router = inject(Router);
  return whenReady(() => {
    const role = auth.role();
    return !role || allowed(role) || router.createUrlTree([ROLE_META[role].home]);
  });
}

export const guestGuard: CanActivateFn = () => homeUnless(() => false);

const OPEN_TO_ALL = new Set(['forbidden', '**']);

export const customerSiteGuard: CanActivateFn = (route) =>
  OPEN_TO_ALL.has(route.routeConfig?.path ?? '') || homeUnless((role) => role === 'customer');

/** Admin routes: needs any of the permissions; otherwise back to the user's own dashboard. */
export const permissionGuard =
  (...permissions: Permission[]): CanActivateFn =>
  () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    return whenReady(() => {
      const role = auth.role();
      if (!role) return router.createUrlTree(['/login']);
      return permissions.some((p) => auth.can(p)) || router.createUrlTree([ROLE_META[role].home]);
    });
  };
