import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  MyTicket,
  NewTicket,
  SupportDashboard,
  TicketDetail,
  TicketPage,
  TicketQuery,
  TicketUpdate,
} from '../../shared/models/admin-roles.models';
import { ApiResponse, Paginated } from '../../shared/models/api.models';
import { toParams } from './http-params';

const data = <T>() => map((r: ApiResponse<T>) => r.data);
const ticket = <T>() => map((r: ApiResponse<{ ticket: T }>) => r.data.ticket);

/** Customers, restaurants and riders: their own support tickets. */
@Injectable({ providedIn: 'root' })
export class SupportService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.baseUrl}/support/tickets`;

  mine = (query: { status?: 'open' | 'closed'; page?: number; limit?: number }) =>
    this.http.get<ApiResponse<Paginated<MyTicket>>>(this.url, { params: toParams(query) }).pipe(data());
  create = (input: NewTicket): Observable<MyTicket> =>
    this.http.post<ApiResponse<{ ticket: MyTicket }>>(this.url, input).pipe(ticket());
  get = (id: string): Observable<MyTicket> =>
    this.http.get<ApiResponse<{ ticket: MyTicket }>>(`${this.url}/${id}`).pipe(ticket());
  reply = (id: string, body: string): Observable<MyTicket> =>
    this.http.post<ApiResponse<{ ticket: MyTicket }>>(`${this.url}/${id}/messages`, { body }).pipe(ticket());
}

/** Support staff: the ticket queue. */
@Injectable({ providedIn: 'root' })
export class SupportDeskService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.baseUrl}/admin/support`;
  private readonly tickets = `${this.url}/tickets`;

  dashboard = (): Observable<SupportDashboard> =>
    this.http.get<ApiResponse<SupportDashboard>>(`${this.url}/dashboard`).pipe(data());
  staff = () =>
    this.http
      .get<ApiResponse<{ items: { id: string; name: string; role: string }[] }>>(`${this.url}/staff`)
      .pipe(map((r) => r.data.items));
  list = (query: TicketQuery): Observable<TicketPage> =>
    this.http.get<ApiResponse<TicketPage>>(this.tickets, { params: toParams(query) }).pipe(data());
  get = (id: string): Observable<TicketDetail> =>
    this.http.get<ApiResponse<{ ticket: TicketDetail }>>(`${this.tickets}/${id}`).pipe(ticket());
  update = (id: string, change: TicketUpdate): Observable<TicketDetail> =>
    this.http.patch<ApiResponse<{ ticket: TicketDetail }>>(`${this.tickets}/${id}`, change).pipe(ticket());
  message = (id: string, body: string, internal: boolean): Observable<TicketDetail> =>
    this.http
      .post<ApiResponse<{ ticket: TicketDetail }>>(`${this.tickets}/${id}/messages`, { body, internal })
      .pipe(ticket());
  escalate = (id: string, note: string): Observable<TicketDetail> =>
    this.http
      .post<ApiResponse<{ ticket: TicketDetail }>>(`${this.tickets}/${id}/escalate`, { note })
      .pipe(ticket());
}
