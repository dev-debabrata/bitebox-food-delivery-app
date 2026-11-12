import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api.models';
import {
  AdminOrderReviewPage,
  AdminOrderReviews,
  AdminReviewDetail,
  ModerationAction,
  MyReview,
  OrderRatingInput,
  OrderReviewState,
  PublicReview,
  ReportReason,
  RestaurantOrderReviews,
  RestaurantReview,
  RestaurantReviewSummary,
  ReviewAnalytics,
  ReviewPage,
  ReviewSort,
  ReviewStatus,
  ReviewTarget,
  RiderReview,
} from '../../shared/models/review.models';
import { publicRequest } from '../interceptors/auth.interceptor';
import { toParams } from './http-params';

export interface ReviewListQuery {
  rating?: number;
  sort?: ReviewSort;
  page?: number;
  limit?: number;
}

export interface NewReview {
  orderId: string;
  target: ReviewTarget;
  foodItemId?: string;
  rating: number;
  comment?: string;
  images?: string[];
}

const id = encodeURIComponent;

@Injectable({ providedIn: 'root' })
export class ReviewService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.baseUrl;

  private get<T>(path: string, query: object = {}, isPublic = false): Observable<T> {
    return this.http
      .get<ApiResponse<T>>(`${this.api}/${path}`, {
        params: toParams(query),
        ...(isPublic && { context: publicRequest() }),
      })
      .pipe(map((r) => r.data));
  }

  private review<T>(request: Observable<ApiResponse<{ review: T }>>): Observable<T> {
    return request.pipe(map((r) => r.data.review));
  }

  // Public
  restaurantReviews(slug: string, query: ReviewListQuery): Observable<ReviewPage<PublicReview>> {
    return this.get(`restaurants/${id(slug)}/reviews`, query, true);
  }

  foodReviews(foodId: string, query: ReviewListQuery): Observable<ReviewPage<PublicReview>> {
    return this.get(`foods/${id(foodId)}/reviews`, query, true);
  }

  // Customer
  forOrder(orderId: string): Observable<OrderReviewState> {
    return this.get(`orders/${id(orderId)}/reviews`);
  }

  /** Restaurant, food quality and delivery in one go; answers with the updated state. */
  rateOrder(orderId: string, input: OrderRatingInput): Observable<OrderReviewState> {
    return this.http
      .post<ApiResponse<OrderReviewState>>(`${this.api}/orders/${id(orderId)}/reviews`, input)
      .pipe(map((r) => r.data));
  }

  mine(query: ReviewListQuery & { target?: ReviewTarget }): Observable<ReviewPage<MyReview>> {
    return this.get('reviews/mine', query);
  }

  create(input: NewReview): Observable<MyReview> {
    return this.review(this.http.post<ApiResponse<{ review: MyReview }>>(`${this.api}/reviews`, input));
  }

  update(
    reviewId: string,
    input: { rating?: number; comment?: string; images?: string[] },
  ): Observable<MyReview> {
    return this.review(
      this.http.patch<ApiResponse<{ review: MyReview }>>(`${this.api}/reviews/${id(reviewId)}`, input),
    );
  }

  remove(reviewId: string): Observable<void> {
    return this.http
      .delete<ApiResponse<unknown>>(`${this.api}/reviews/${id(reviewId)}`)
      .pipe(map(() => undefined));
  }

  /** Customers, the reviewed restaurant and the reviewed rider can report a published review. */
  report(reviewId: string, input: { reason: ReportReason; note?: string }): Observable<void> {
    return this.http
      .post<ApiResponse<unknown>>(`${this.api}/reviews/${id(reviewId)}/reports`, input)
      .pipe(map(() => undefined));
  }

  // Restaurant
  /** One row per order (filters pick the orders; a row shows the whole order). */
  restaurantOrders(
    query: ReviewListQuery & {
      target?: 'restaurant' | 'food';
      foodItemId?: string;
      responded?: boolean;
    },
  ): Observable<ReviewPage<RestaurantOrderReviews>> {
    const { responded, ...rest } = query;
    return this.get('my/restaurant/reviews/orders', {
      ...rest,
      ...(responded !== undefined && { responded: String(responded) }),
    });
  }

  restaurantOrder(orderId: string): Observable<RestaurantOrderReviews> {
    return this.get(`my/restaurant/reviews/orders/${id(orderId)}`);
  }

  restaurantSummary(): Observable<RestaurantReviewSummary> {
    return this.get('my/restaurant/reviews/summary');
  }

  respond(reviewId: string, text: string): Observable<RestaurantReview> {
    return this.review(
      this.http.put<ApiResponse<{ review: RestaurantReview }>>(
        `${this.api}/my/restaurant/reviews/${id(reviewId)}/response`,
        { text },
      ),
    );
  }

  deleteResponse(reviewId: string): Observable<RestaurantReview> {
    return this.review(
      this.http.delete<ApiResponse<{ review: RestaurantReview }>>(
        `${this.api}/my/restaurant/reviews/${id(reviewId)}/response`,
      ),
    );
  }

  // Rider
  riderReviews(query: ReviewListQuery): Observable<ReviewPage<RiderReview>> {
    return this.get('delivery/reviews', query);
  }

  // Admin
  /** One row per order; `reported` puts orders with open reports first. */
  adminOrders(query: {
    target?: ReviewTarget;
    status?: ReviewStatus;
    reported?: boolean;
    rating?: number;
    search?: string;
    page?: number;
    limit?: number;
  }): Observable<AdminOrderReviewPage> {
    return this.get('admin/reviews/orders', query);
  }

  adminOrder(orderId: string): Observable<AdminOrderReviews<AdminReviewDetail>> {
    return this.get(`admin/reviews/orders/${id(orderId)}`);
  }

  moderate(
    reviewId: string,
    action: ModerationAction,
    reason: string,
  ): Observable<AdminReviewDetail> {
    return this.review(
      this.http.post<ApiResponse<{ review: AdminReviewDetail }>>(
        `${this.api}/admin/reviews/${id(reviewId)}/moderation`,
        { action, reason },
      ),
    );
  }

  dismissReports(reviewId: string, reason: string): Observable<AdminReviewDetail> {
    return this.review(
      this.http.post<ApiResponse<{ review: AdminReviewDetail }>>(
        `${this.api}/admin/reviews/${id(reviewId)}/reports/dismiss`,
        { reason },
      ),
    );
  }

  analytics(days: number): Observable<ReviewAnalytics> {
    return this.get('admin/reviews/analytics', { days });
  }
}
