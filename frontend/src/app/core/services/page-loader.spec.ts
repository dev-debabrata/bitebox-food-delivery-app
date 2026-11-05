import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PageLoader, inBackground, pageLoaderInterceptor } from './page-loader';

describe('PageLoader', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let loader: PageLoader;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([pageLoaderInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    loader = TestBed.inject(PageLoader);
  });

  afterEach(() => {
    backend.verify();
    vi.useRealTimers();
  });

  it('shows after a short delay and hides once every request has finished', () => {
    http.get('/api/a').subscribe();
    http.get('/api/b').subscribe();
    vi.advanceTimersByTime(100);
    expect(loader.visible()).toBe(false);

    vi.advanceTimersByTime(150);
    expect(loader.visible()).toBe(true);

    backend.expectOne('/api/a').flush({});
    expect(loader.visible()).toBe(true);
    backend.expectOne('/api/b').flush({});
    expect(loader.visible()).toBe(false);
  });

  it('never shows for a request that finishes quickly', () => {
    http.get('/api/a').subscribe();
    backend.expectOne('/api/a').flush({});
    vi.advanceTimersByTime(500);
    expect(loader.visible()).toBe(false);
  });

  it('ignores background requests such as polls', () => {
    inBackground(http.get('/api/poll')).subscribe();
    vi.advanceTimersByTime(500);
    expect(loader.visible()).toBe(false);
    backend.expectOne('/api/poll').flush({});
  });

  it('hides when a request fails', () => {
    http.get('/api/a').subscribe({ error: () => undefined });
    vi.advanceTimersByTime(300);
    backend.expectOne('/api/a').flush({}, { status: 500, statusText: 'Server Error' });
    expect(loader.visible()).toBe(false);
  });
});
