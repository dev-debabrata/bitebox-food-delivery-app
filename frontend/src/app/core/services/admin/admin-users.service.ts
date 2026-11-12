import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { ApiResponse, Paginated } from '../../../shared/models/api.models';
import { Role, User, UserStatus } from '../../../shared/models/user.models';

export interface UserQuery {
  role?: Role;
  status?: UserStatus;
  search?: string;
  page?: number;
  limit?: number;
}

@Injectable({ providedIn: 'root' })
export class AdminUsersService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.baseUrl}/admin/users`;

  list(query: UserQuery = {}): Observable<Paginated<User>> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params = params.set(key, String(value));
    }
    return this.http.get<ApiResponse<Paginated<User>>>(this.url, { params }).pipe(map((res) => res.data));
  }

  setStatus(id: string, status: UserStatus): Observable<User> {
    return this.http
      .patch<ApiResponse<{ user: User }>>(`${this.url}/${id}/status`, { status })
      .pipe(map((res) => res.data.user));
  }

  /** Total number of accounts for a role (uses the pagination total). */
  countByRole(role: Role): Observable<number> {
    return this.list({ role, limit: 1 }).pipe(map((page) => page.pagination.total));
  }
}
