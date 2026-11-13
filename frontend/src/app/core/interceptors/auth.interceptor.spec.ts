import {
  HttpClient,
  HttpErrorResponse,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ROLE_META } from '../../shared/models/user.models';
import { AuthService } from '../auth/auth.service';
import { authInterceptor, publicRequest } from './auth.interceptor';

describe('authInterceptor', () => {
  const api = environment.baseUrl;
  let http: HttpClient;
  let backend: HttpTestingController;
  let refresh: () => Observable<string>;
  const auth = {
    accessToken: 'old-token' as string | null,
    role: () => 'customer' as const,
    refresh: () => refresh(),
  };
  const router = { url: '/orders', navigate: vi.fn(() => Promise.resolve(true)) };

  beforeEach(() => {
    auth.accessToken = 'old-token';
    refresh = () => of('new-token');
    router.navigate.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
        { provide: Router, useValue: router },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  const unauthorized = { status: 401, statusText: 'Unauthorized' };

  it('adds the token and the CSRF header to API calls, and cookies only for /auth', () => {
    http.get(`${api}/orders`).subscribe();
    const orders = backend.expectOne(`${api}/orders`);
    expect(orders.request.headers.get('Authorization')).toBe('Bearer old-token');
    expect(orders.request.headers.get('X-Requested-With')).toBe('BiteBox');
    expect(orders.request.withCredentials).toBe(false);
    orders.flush({});

    http.post(`${api}/auth/logout`, {}).subscribe();
    const logout = backend.expectOne(`${api}/auth/logout`);
    expect(logout.request.withCredentials).toBe(true);
    logout.flush({});
  });

  it('never sends the token to other sites or on public catalogue calls', () => {
    http.get('https://tiles.example/1/2/3.png').subscribe();
    const tile = backend.expectOne('https://tiles.example/1/2/3.png');
    expect(tile.request.headers.has('Authorization')).toBe(false);
    tile.flush('');

    http.get(`${api}/restaurants`, { context: publicRequest() }).subscribe();
    const list = backend.expectOne(`${api}/restaurants`);
    expect(list.request.headers.has('Authorization')).toBe(false);
    expect(list.request.withCredentials).toBe(false);
    list.flush({});
  });

  it('refreshes once on a 401 and repeats the request with the new token', () => {
    let body: unknown;
    http.get(`${api}/orders`).subscribe((b) => (body = b));
    backend.expectOne(`${api}/orders`).flush(null, unauthorized);
    const retry = backend.expectOne(`${api}/orders`);
    expect(retry.request.headers.get('Authorization')).toBe('Bearer new-token');
    retry.flush({ ok: true });
    expect(body).toEqual({ ok: true });
  });

  it('does not refresh for the auth endpoints or when signed out', () => {
    let error: HttpErrorResponse | undefined;
    http.post(`${api}/auth/login`, {}).subscribe({ error: (e) => (error = e) });
    backend.expectOne(`${api}/auth/login`).flush(null, unauthorized);
    expect(error?.status).toBe(401);

    auth.accessToken = null;
    http.get(`${api}/orders`).subscribe({ error: (e) => (error = e) });
    const anonymous = backend.expectOne(`${api}/orders`);
    expect(anonymous.request.headers.has('Authorization')).toBe(false);
    anonymous.flush(null, unauthorized);
    backend.expectNone(`${api}/orders`);
  });

  it('sends the user to sign in again when the refresh is refused', () => {
    refresh = () => throwError(() => new HttpErrorResponse(unauthorized));
    let error: HttpErrorResponse | undefined;
    http.get(`${api}/orders`).subscribe({ error: (e) => (error = e) });
    backend.expectOne(`${api}/orders`).flush(null, unauthorized);
    expect(error?.status).toBe(401);
    expect(router.navigate).toHaveBeenCalledWith([ROLE_META.customer.login], {
      queryParams: { returnUrl: '/orders', reason: 'expired' },
    });
  });

  it('keeps the user signed in when the refresh fails because the network is down', () => {
    refresh = () =>
      throwError(() => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error' }));
    http.get(`${api}/orders`).subscribe({ error: () => undefined });
    backend.expectOne(`${api}/orders`).flush(null, unauthorized);
    expect(router.navigate).not.toHaveBeenCalled();
  });
});
