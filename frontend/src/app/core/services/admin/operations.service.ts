import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../../environments/environment';
import {
  DeliveryPerformance,
  Monitoring,
  OperationsDashboard,
  RestaurantAvailability,
} from '../../../shared/models/admin-roles.models';
import { ApiResponse } from '../../../shared/models/api.models';
import { toParams } from '../http-params';

@Injectable({ providedIn: 'root' })
export class OperationsService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiUrl}/admin/operations`;

  private get<T>(path: string, query: object = {}): Observable<T> {
    return this.http
      .get<ApiResponse<T>>(`${this.url}/${path}`, { params: toParams(query) })
      .pipe(map((r) => r.data));
  }

  dashboard = (days: number) => this.get<OperationsDashboard>('dashboard', { days });
  monitoring = () => this.get<Monitoring>('monitoring');
  restaurants = () =>
    this.get<{ items: RestaurantAvailability[] }>('restaurants').pipe(map((d) => d.items));
  performance = (days: number) => this.get<DeliveryPerformance>('performance', { days });
}
