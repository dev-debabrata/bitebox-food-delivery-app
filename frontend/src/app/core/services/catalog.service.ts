import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map, shareReplay } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse, Paginated } from '../../shared/models/api.models';
import {
  DishSearchResult,
  FoodCategory,
  MenuSection,
  Restaurant,
  RestaurantQuery,
} from '../../shared/models/catalog.models';
import { toParams } from './http-params';
import { publicRequest } from '../interceptors/auth.interceptor';

/**
 * Public, unauthenticated catalogue: restaurants, menus, categories and dishes.
 * Requests are sent without the access token (see `publicRequest`).
 */
@Injectable({ providedIn: 'root' })
export class CatalogService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  // Categories change rarely; share one request per app session.
  private categories$?: Observable<FoodCategory[]>;

  restaurants(query: RestaurantQuery = {}): Observable<Paginated<Restaurant>> {
    return this.http
      .get<ApiResponse<Paginated<Restaurant>>>(`${this.api}/restaurants`, { context: publicRequest(), params: toParams(query) })
      .pipe(map((res) => res.data));
  }

  cuisines(): Observable<string[]> {
    return this.http
      .get<ApiResponse<{ cuisines: string[] }>>(`${this.api}/restaurants/cuisines`, { context: publicRequest() })
      .pipe(map((res) => res.data.cuisines));
  }

  restaurant(slug: string): Observable<Restaurant> {
    return this.http
      .get<ApiResponse<{ restaurant: Restaurant }>>(`${this.api}/restaurants/${encodeURIComponent(slug)}`, { context: publicRequest() })
      .pipe(map((res) => res.data.restaurant));
  }

  menu(slug: string): Observable<MenuSection[]> {
    return this.http
      .get<ApiResponse<{ sections: MenuSection[] }>>(`${this.api}/restaurants/${encodeURIComponent(slug)}/menu`, { context: publicRequest() })
      .pipe(map((res) => res.data.sections));
  }

  categories(): Observable<FoodCategory[]> {
    this.categories$ ??= this.http
      .get<ApiResponse<{ categories: FoodCategory[] }>>(`${this.api}/categories`, { context: publicRequest() })
      .pipe(
        map((res) => res.data.categories),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    return this.categories$;
  }

  dishes(query: { search?: string; category?: string; veg?: boolean; page?: number; limit?: number }): Observable<Paginated<DishSearchResult>> {
    return this.http
      .get<ApiResponse<Paginated<DishSearchResult>>>(`${this.api}/foods`, { context: publicRequest(), params: toParams(query) })
      .pipe(map((res) => res.data));
  }

  dish(id: string): Observable<DishSearchResult> {
    return this.http
      .get<ApiResponse<{ item: DishSearchResult }>>(`${this.api}/foods/${encodeURIComponent(id)}`, { context: publicRequest() })
      .pipe(map((res) => res.data.item));
  }
}
