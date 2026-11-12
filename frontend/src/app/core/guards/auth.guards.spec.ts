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
import { ADMIN_ROLES, Permission, Role } from '../../shared/models/user.models';
import { AuthService } from '../auth/auth.service';
import { customerSiteGuard, guestGuard, permissionGuard, roleGuard } from './auth.guards';

class FakeAuth {
  readonly initialised = signal(true);
  readonly role = signal<Role | null>(null);
  readonly permissions = signal<Permission[]>([]);
  can(p: Permission): boolean {
    return this.permissions().includes(p);
  }
}

async function run(guard: typeof guestGuard, url = '/admin/users', path = ''): Promise<boolean | UrlTree> {
  const result = TestBed.runInInjectionContext(() =>
    guard({ routeConfig: { path } } as ActivatedRouteSnapshot, { url } as RouterStateSnapshot),
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

  describe('customerSiteGuard', () => {
    it.each<Role | null>([null, 'customer'])('lets %s browse the customer site', async (role) => {
      auth.role.set(role);
      expect(await run(customerSiteGuard, '/')).toBe(true);
    });

    it.each<[Role, string]>([
      ['admin', '/admin'],
      ['restaurant', '/restaurant'],
      ['delivery', '/delivery'],
    ])('sends %s to their own panel', async (role, home) => {
      auth.role.set(role);
      expect(serialize(await run(customerSiteGuard, '/restaurants', 'restaurants'))).toBe(home);
    });

    it('still shows staff the error pages', async () => {
      auth.role.set('admin');
      expect(await run(customerSiteGuard, '/forbidden', 'forbidden')).toBe(true);
    });
  });

  describe('permissionGuard', () => {
    it('lets every admin role into the admin panel shell', async () => {
      for (const role of ADMIN_ROLES) {
        auth.role.set(role);
        expect(await run(roleGuard(...ADMIN_ROLES))).toBe(true);
      }
    });

    it('allows an admin with the permission', async () => {
      auth.role.set('finance_admin');
      auth.permissions.set(['finance:view', 'payouts:manage']);
      expect(await run(permissionGuard('payouts:manage'))).toBe(true);
    });

    it("sends an admin without the permission to their own dashboard", async () => {
      auth.role.set('support_admin');
      auth.permissions.set(['support:manage', 'orders:view']);
      expect(serialize(await run(permissionGuard('finance:view')))).toBe('/admin/support');
      auth.role.set('operations_admin');
      auth.permissions.set(['operations:view']);
      expect(serialize(await run(permissionGuard('admins:manage')))).toBe('/admin/operations');
    });

    it('sends signed-out visitors to the login page', async () => {
      expect(serialize(await run(permissionGuard('orders:view')))).toBe('/login');
    });

    it('never redirects to the page that was refused (no redirect loop)', async () => {
      auth.role.set('finance_admin');
      auth.permissions.set([]);
      expect(serialize(await run(permissionGuard('finance:view'), '/admin/finance?days=30'))).toBe('/forbidden');
    });
  });
});
