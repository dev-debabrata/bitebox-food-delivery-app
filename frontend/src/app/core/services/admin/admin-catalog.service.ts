import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { ApiResponse, Paginated } from '../../../shared/models/api.models';
import {
  AdminRestaurant,
  FoodCategory,
  FoodCategoryInput,
  FoodItem,
  MenuStats,
  RestaurantStatus,
} from '../../../shared/models/catalog.models';
import { toParams } from '../http-params';

export type AdminFoodItem = Omit<FoodItem, 'restaurant'> & {
  restaurant: { _id?: string; id?: string; name: string; slug: string; status: RestaurantStatus };
};

@Injectable({ providedIn: 'root' })
export class AdminCatalogService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiUrl}/admin`;

  // Restaurants
  restaurants(query: {
    status?: RestaurantStatus;
    search?: string;
    page?: number;
    limit?: number;
  }): Observable<Paginated<AdminRestaurant>> {
    return this.http
      .get<ApiResponse<Paginated<AdminRestaurant>>>(`${this.url}/restaurants`, {
        params: toParams(query),
      })
      .pipe(map((res) => res.data));
  }

  restaurantCounts(): Observable<Record<RestaurantStatus, number>> {
    return this.http
      .get<ApiResponse<{ counts: Record<RestaurantStatus, number> }>>(
        `${this.url}/restaurants/counts`,
      )
      .pipe(map((res) => res.data.counts));
  }

  restaurant(id: string): Observable<{ restaurant: AdminRestaurant; stats: MenuStats }> {
    return this.http
      .get<ApiResponse<{ restaurant: AdminRestaurant; stats: MenuStats }>>(
        `${this.url}/restaurants/${id}`,
      )
      .pipe(map((res) => res.data));
  }

  setRestaurantStatus(
    id: string,
    status: RestaurantStatus,
    reason?: string,
  ): Observable<AdminRestaurant> {
    return this.http
      .patch<ApiResponse<{ restaurant: AdminRestaurant }>>(`${this.url}/restaurants/${id}/status`, {
        status,
        ...(reason ? { reason } : {}),
      })
      .pipe(map((res) => res.data.restaurant));
  }

  // Categories
  categories(): Observable<FoodCategory[]> {
    return this.http
      .get<ApiResponse<{ categories: FoodCategory[] }>>(`${this.url}/categories`)
      .pipe(map((res) => res.data.categories));
  }

  createCategory(input: FoodCategoryInput): Observable<FoodCategory> {
    return this.http
      .post<ApiResponse<{ category: FoodCategory }>>(`${this.url}/categories`, input)
      .pipe(map((res) => res.data.category));
  }

  updateCategory(id: string, input: FoodCategoryInput): Observable<FoodCategory> {
    return this.http
      .patch<ApiResponse<{ category: FoodCategory }>>(`${this.url}/categories/${id}`, input)
      .pipe(map((res) => res.data.category));
  }

  deleteCategory(id: string): Observable<void> {
    return this.http
      .delete<ApiResponse<null>>(`${this.url}/categories/${id}`)
      .pipe(map(() => undefined));
  }

  // Food items
  foods(query: {
    search?: string;
    restaurant?: string;
    available?: boolean;
    page?: number;
    limit?: number;
  }): Observable<Paginated<AdminFoodItem>> {
    return this.http
      .get<ApiResponse<Paginated<AdminFoodItem>>>(`${this.url}/foods`, { params: toParams(query) })
      .pipe(map((res) => res.data));
  }

  setFoodAvailability(id: string, isAvailable: boolean): Observable<AdminFoodItem> {
    return this.http
      .patch<ApiResponse<{ item: AdminFoodItem }>>(`${this.url}/foods/${id}/availability`, {
        isAvailable,
      })
      .pipe(map((res) => res.data.item));
  }

  deleteFood(id: string): Observable<void> {
    return this.http
      .delete<ApiResponse<null>>(`${this.url}/foods/${id}`)
      .pipe(map(() => undefined));
  }
}
