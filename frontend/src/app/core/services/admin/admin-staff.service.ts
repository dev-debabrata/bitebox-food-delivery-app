import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../../environments/environment';
import {
  AuditEntry,
  LoginEntry,
  PlatformSummary,
  StaffAdminInput,
  StaffAdminUpdate,
  StaffQuery,
} from '../../../shared/models/admin-roles.models';
import { ApiResponse, Paginated } from '../../../shared/models/api.models';
import { User, UserStatus } from '../../../shared/models/user.models';
import { toParams } from '../http-params';

/** Super admin: operations, finance and support admin accounts, and the audit log. */
@Injectable({ providedIn: 'root' })
export class AdminStaffService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.baseUrl}/admin/admins`;

  list(query: StaffQuery): Observable<Paginated<User>> {
    return this.http
      .get<ApiResponse<Paginated<User>>>(this.url, { params: toParams(query) })
      .pipe(map((r) => r.data));
  }

  create(input: StaffAdminInput): Observable<User> {
    return this.http
      .post<ApiResponse<{ user: User }>>(this.url, input)
      .pipe(map((r) => r.data.user));
  }

  update(id: string, input: StaffAdminUpdate): Observable<User> {
    return this.http
      .patch<ApiResponse<{ user: User }>>(`${this.url}/${id}`, input)
      .pipe(map((r) => r.data.user));
  }

  /** Sign-ins of a staff admin, newest first (Django API only: the Node API answers 404). */
  logins(id: string, page = 1, limit = 20): Observable<Paginated<LoginEntry>> {
    return this.http
      .get<ApiResponse<Paginated<LoginEntry>>>(`${this.url}/${encodeURIComponent(id)}/logins`, {
        params: toParams({ page, limit }),
      })
      .pipe(map((r) => r.data));
  }

  /** The admin home page's platform figures (Django API only: the Node API answers 404). */
  summary(): Observable<PlatformSummary> {
    return this.http
      .get<ApiResponse<PlatformSummary>>(`${environment.baseUrl}/admin/dashboard`)
      .pipe(map((r) => r.data));
  }

  setStatus(id: string, status: UserStatus): Observable<User> {
    return this.http
      .patch<ApiResponse<{ user: User }>>(`${this.url}/${id}/status`, { status })
      .pipe(map((r) => r.data.user));
  }

  auditLog(query: {
    action?: string;
    role?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): Observable<Paginated<AuditEntry>> {
    return this.http
      .get<ApiResponse<Paginated<AuditEntry>>>(`${environment.baseUrl}/admin/audit-logs`, {
        params: toParams(query),
      })
      .pipe(map((r) => r.data));
  }
}
