import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import { apiRouterInterceptor } from './api-router.interceptor';

describe('apiRouterInterceptor', () => {
  const env = environment as { baseUrl: string; djangoUrl?: string; djangoRoutes?: string[] };
  const routes = [...(env.djangoRoutes ?? [])];
  const originalDjangoUrl = env.djangoUrl;
  let http: HttpClient;
  let backend: HttpTestingController;

  beforeEach(() => {
    env.djangoRoutes = ['/health', '/auth'];
    env.djangoUrl = 'http://localhost:8000/api/v1';
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([apiRouterInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    backend.verify();
    env.djangoRoutes = routes;
    env.djangoUrl = originalDjangoUrl;
  });

  it('sends migrated paths to Django, keeping the method, body and headers', () => {
    http
      .post(
        `${environment.baseUrl}/auth/login`,
        { email: 'asha@bitebox.test' },
        {
          headers: { Authorization: 'Bearer t' },
          withCredentials: true,
        },
      )
      .subscribe();
    const req = backend.expectOne(`${env.djangoUrl}/auth/login`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ email: 'asha@bitebox.test' });
    expect(req.request.headers.get('Authorization')).toBe('Bearer t');
    expect(req.request.withCredentials).toBe(true);
    req.flush({});
  });

  it('matches whole path segments and query strings only', () => {
    http.get(`${environment.baseUrl}/health`).subscribe();
    http.get(`${environment.baseUrl}/health?full=1`).subscribe();
    http.get(`${environment.baseUrl}/healthcheck`).subscribe(); // not /health
    http.get(`${environment.baseUrl}/authors`).subscribe(); // not /auth
    backend.expectOne(`${env.djangoUrl}/health`).flush({});
    backend.expectOne(`${env.djangoUrl}/health?full=1`).flush({});
    backend.expectOne(`${environment.baseUrl}/healthcheck`).flush({});
    backend.expectOne(`${environment.baseUrl}/authors`).flush({});
  });

  it('leaves everything else on Node and ignores other hosts', () => {
    http.get(`${environment.baseUrl}/restaurants`).subscribe();
    http.get('https://tile.openstreetmap.org/1/1/1.png').subscribe();
    backend.expectOne(`${environment.baseUrl}/restaurants`).flush({});
    backend.expectOne('https://tile.openstreetmap.org/1/1/1.png').flush({});
  });
});
