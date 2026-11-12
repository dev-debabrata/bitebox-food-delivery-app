import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { environment } from '../../../environments/environment';
import { User } from '../../shared/models/user.models';
import { authInterceptor } from '../interceptors/auth.interceptor';
import { AuthService } from './auth.service';

const api = environment.apiUrl;
const user: User = {
  id: 'u1',
  name: 'Asha Customer',
  email: 'asha@example.com',
  role: 'customer',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const session = (accessToken: string, u: User = user) => ({
  success: true,
  message: 'ok',
  data: { user: u, accessToken },
});

describe('AuthService', () => {
  let auth: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('stores the user and access token in memory after login', () => {
    let result: User | undefined;
    auth.login({ email: user.email, password: 'Secret123', portal: 'customer' }).subscribe((u) => (result = u));

    const req = http.expectOne(`${api}/auth/login`);
    expect(req.request.body).toEqual({ email: user.email, password: 'Secret123', portal: 'customer' });
    expect(req.request.withCredentials).toBe(true);
    expect(req.request.headers.get('X-Requested-With')).toBe('BiteBox');
    req.flush(session('access-1'));

    expect(result).toEqual(user);
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.role()).toBe('customer');
    expect(auth.accessToken).toBe('access-1');
  });

  it('never writes tokens to localStorage or sessionStorage', () => {
    auth.login({ email: user.email, password: 'Secret123' }).subscribe();
    http.expectOne(`${api}/auth/login`).flush(session('access-1'));
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored).not.toContain('access-1');
  });

  it('restores a session from the refresh cookie and marks itself initialised', () => {
    expect(auth.initialised()).toBe(false);
    auth.restoreSession().subscribe();
    http.expectOne(`${api}/auth/refresh`).flush(session('access-2'));
    expect(auth.initialised()).toBe(true);
    expect(auth.user()?.email).toBe(user.email);
  });

  it('stays signed out (but initialised) when there is no valid refresh cookie', () => {
    auth.restoreSession().subscribe();
    http
      .expectOne(`${api}/auth/refresh`)
      .flush({ success: false, message: 'No session' }, { status: 401, statusText: 'Unauthorized' });
    expect(auth.initialised()).toBe(true);
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('shares one refresh request between concurrent callers', () => {
    const tokens: string[] = [];
    auth.refresh().subscribe((t) => tokens.push(t));
    auth.refresh().subscribe((t) => tokens.push(t));
    http.expectOne(`${api}/auth/refresh`).flush(session('access-3'));
    expect(tokens).toEqual(['access-3', 'access-3']);
  });

  it('attaches the bearer token and transparently refreshes once on 401', () => {
    auth.login({ email: user.email, password: 'Secret123' }).subscribe();
    http.expectOne(`${api}/auth/login`).flush(session('old-token'));

    let body: unknown;
    TestBed.inject(HttpClient).get(`${api}/admin/users`).subscribe((b) => (body = b));

    const first = http.expectOne(`${api}/admin/users`);
    expect(first.request.headers.get('Authorization')).toBe('Bearer old-token');
    first.flush({ success: false, message: 'expired' }, { status: 401, statusText: 'Unauthorized' });

    http.expectOne(`${api}/auth/refresh`).flush(session('new-token'));

    const retry = http.expectOne(`${api}/admin/users`);
    expect(retry.request.headers.get('Authorization')).toBe('Bearer new-token');
    retry.flush({ ok: true });
    expect(body).toEqual({ ok: true });
  });

  it('logout clears state and sends the user to their login page', () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    auth.login({ email: user.email, password: 'Secret123' }).subscribe();
    http.expectOne(`${api}/auth/login`).flush(session('access-1'));

    auth.logout().subscribe();
    http.expectOne(`${api}/auth/logout`).flush({ success: true, message: 'bye', data: null });

    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.accessToken).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/login');
  });
});
