import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse, Paginated } from '../../shared/models/api.models';
import {
  FoodItem,
  FoodItemInput,
  MenuStats,
  Restaurant,
  RestaurantInput,
} from '../../shared/models/catalog.models';
import { toParams } from './http-params';

export interface MyRestaurantState {
  restaurant: Restaurant | null;
  stats: MenuStats | null;
}

/** The dashboard's order figures (GET /my/restaurant/stats). Money in paise. */
export interface RestaurantStats {
  totalOrders: number;
  todayOrders: number;
  pendingOrders: number;
  completedOrders: number;
  cancelledOrders: number;
  salesPaise: number;
  averageOrderPaise: number;
  rating: { average: number; count: number };
}

@Injectable({ providedIn: 'root' })
export class MyRestaurantService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.baseUrl}/my/restaurant`;

  get(): Observable<MyRestaurantState> {
    return this.http.get<ApiResponse<MyRestaurantState>>(this.url).pipe(map((res) => res.data));
  }

  stats(): Observable<RestaurantStats> {
    return this.http
      .get<ApiResponse<RestaurantStats>>(`${this.url}/stats`)
      .pipe(map((res) => res.data));
  }

  create(input: RestaurantInput): Observable<Restaurant> {
    return this.http
      .post<ApiResponse<{ restaurant: Restaurant }>>(this.url, input)
      .pipe(map((res) => res.data.restaurant));
  }

  update(input: Partial<RestaurantInput>): Observable<Restaurant> {
    return this.http
      .patch<ApiResponse<{ restaurant: Restaurant }>>(this.url, input)
      .pipe(map((res) => res.data.restaurant));
  }

  setAcceptingOrders(isAcceptingOrders: boolean): Observable<Restaurant> {
    return this.http
      .patch<ApiResponse<{ restaurant: Restaurant }>>(`${this.url}/accepting-orders`, {
        isAcceptingOrders,
      })
      .pipe(map((res) => res.data.restaurant));
  }

  foods(
    query: {
      search?: string;
      category?: string;
      available?: boolean;
      page?: number;
      limit?: number;
    } = {},
  ): Observable<Paginated<FoodItem>> {
    return this.http
      .get<ApiResponse<Paginated<FoodItem>>>(`${this.url}/foods`, { params: toParams(query) })
      .pipe(map((res) => res.data));
  }

  createFood(input: FoodItemInput): Observable<FoodItem> {
    return this.http
      .post<ApiResponse<{ item: FoodItem }>>(`${this.url}/foods`, input)
      .pipe(map((res) => res.data.item));
  }

  updateFood(id: string, input: Partial<FoodItemInput>): Observable<FoodItem> {
    return this.http
      .patch<ApiResponse<{ item: FoodItem }>>(`${this.url}/foods/${id}`, input)
      .pipe(map((res) => res.data.item));
  }

  setFoodAvailability(id: string, isAvailable: boolean): Observable<FoodItem> {
    return this.http
      .patch<ApiResponse<{ item: FoodItem }>>(`${this.url}/foods/${id}/availability`, {
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
