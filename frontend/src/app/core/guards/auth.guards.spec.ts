import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  provideRouter,
  Router,
  RouterStateSnapshot,
  UrlTree,
} from '@angular/router';
import { firstValueFrom, isObservable, Observable } from 'rxjs';
import { Role } from '../../shared/models/user.models';
import { AuthService } from '../auth/auth.service';
import { guestGuard, roleGuard } from './auth.guards';

class FakeAuth {
  readonly initialised = signal(true);
  readonly role = signal<Role | null>(null);
}

async function run(guard: typeof guestGuard, url = '/admin/users'): Promise<boolean | UrlTree> {
  const result = TestBed.runInInjectionContext(() =>
    guard({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot),
  );
  return isObservable(result)
    ? firstValueFrom(result as Observable<boolean | UrlTree>)
    : (result as boolean | UrlTree);
}

describe('auth guards', () => {
  let auth: FakeAuth;
  let router: Router;
  const serialize = (r: boolean | UrlTree) => (r instanceof UrlTree ? router.serializeUrl(r) : r);

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useClass: FakeAuth }],
    });
    auth = TestBed.inject(AuthService) as unknown as FakeAuth;
    router = TestBed.inject(Router);
  });

  describe('roleGuard', () => {
    it('sends signed-out users to that role’s login page with a returnUrl', async () => {
      expect(serialize(await run(roleGuard('admin')))).toBe('/login?returnUrl=%2Fadmin%2Fusers');
    });

    it('allows a user with a permitted role', async () => {
      auth.role.set('admin');
      expect(await run(roleGuard('admin'))).toBe(true);
    });

    it.each<Role>(['customer', 'restaurant', 'delivery'])('blocks %s from the admin panel', async (role) => {
      auth.role.set(role);
      expect(serialize(await run(roleGuard('admin')))).toBe('/forbidden');
    });

    it('waits for session restore before deciding', async () => {
      auth.initialised.set(false);
      const pending = run(roleGuard('restaurant'), '/restaurant');
      auth.role.set('restaurant');
      auth.initialised.set(true);
      TestBed.tick();
      expect(await pending).toBe(true);
    });
  });

  describe('guestGuard', () => {
    it('lets signed-out visitors through', async () => {
      expect(await run(guestGuard, '/login')).toBe(true);
    });

    it('redirects signed-in users to their own home', async () => {
      auth.role.set('delivery');
      expect(serialize(await run(guestGuard, '/login'))).toBe('/delivery');
    });
  });
});
