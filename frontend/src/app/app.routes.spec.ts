import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';
import { AuthService } from './core/auth/auth.service';

describe('app routes', () => {
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes, withComponentInputBinding()), provideHttpClient(), provideHttpClientTesting()],
    });
    // Simulate startup with no session cookie so guards can decide.
    TestBed.inject(AuthService).restoreSession().subscribe();
    TestBed.inject(HttpTestingController)
      .expectOne((req) => req.url.endsWith('/auth/refresh'))
      .flush({ success: false, message: 'No session' }, { status: 401, statusText: 'Unauthorized' });
    harness = await RouterTestingHarness.create();
  });

  const visit = async (url: string) => {
    await harness.navigateByUrl(url);
    await harness.fixture.whenStable();
    harness.detectChanges();
    return harness.fixture.nativeElement as HTMLElement;
  };

  it('renders the customer home page at "/" (not the empty auth layout)', async () => {
    const el = await visit('/');
    expect(el.querySelector('bb-customer-layout')).not.toBeNull();
    expect(el.querySelector('bb-auth-layout')).toBeNull();
    expect(el.textContent).toContain('How BiteBox works');
  }, 10000);

  it('has one sign-in page; the old per-role addresses redirect to it', async () => {
    expect((await visit('/login')).textContent).toContain('Sign in');
    for (const old of ['/admin/login', '/restaurant/login', '/delivery/login']) {
      await visit(old);
      expect(TestBed.inject(Router).url).toBe('/login');
    }
    await visit('/restaurant/login?returnUrl=%2Frestaurant%2Forders');
    expect(TestBed.inject(Router).url).toBe('/login?returnUrl=%2Frestaurant%2Forders');
  });

  it('falls back to the 404 page for unknown URLs', async () => {
    expect((await visit('/definitely-not-a-page')).textContent).toContain("isn't on the menu");
  });
});
