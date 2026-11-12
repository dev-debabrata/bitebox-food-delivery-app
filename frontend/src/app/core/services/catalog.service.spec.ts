import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../../environments/environment';
import { CatalogService } from './catalog.service';

describe('CatalogService', () => {
  let service: CatalogService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(CatalogService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('sends only meaningful filters as query params', () => {
    service.restaurants({ search: 'biryani', veg: true, cuisine: '', category: undefined, lat: 12.97, lng: 77.59, page: 2 }).subscribe();
    const req = http.expectOne((r) => r.url === `${environment.apiUrl}/restaurants`);
    expect(req.request.params.keys().sort()).toEqual(['lat', 'lng', 'page', 'search', 'veg']);
    expect(req.request.params.get('veg')).toBe('true');
    req.flush({ success: true, message: 'OK', data: { items: [], pagination: { page: 2, limit: 12, total: 0, totalPages: 0 } } });
  });

  it('omits false flags so they do not filter', () => {
    service.dishes({ search: 'naan', veg: false }).subscribe();
    const req = http.expectOne((r) => r.url === `${environment.apiUrl}/foods`);
    expect(req.request.params.has('veg')).toBe(false);
    req.flush({ success: true, message: 'OK', data: { items: [], pagination: { page: 1, limit: 12, total: 0, totalPages: 0 } } });
  });

  it('caches categories for the session', () => {
    let first: unknown;
    let second: unknown;
    service.categories().subscribe((c) => (first = c));
    http.expectOne(`${environment.apiUrl}/categories`).flush({ success: true, message: 'OK', data: { categories: [{ id: 'c1', name: 'Pizza' }] } });
    service.categories().subscribe((c) => (second = c));
    http.expectNone(`${environment.apiUrl}/categories`);
    expect(second).toEqual(first);
  });

  it('URL-encodes restaurant slugs', () => {
    service.menu('a/b').subscribe();
    http.expectOne(`${environment.apiUrl}/restaurants/a%2Fb/menu`).flush({ success: true, message: 'OK', data: { sections: [] } });
  });
});
