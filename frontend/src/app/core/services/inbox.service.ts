import { HttpClient } from '@angular/common/http';
import {
  DestroyRef,
  Injectable,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Observable, Subscription, map, tap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';
import { ApiResponse, Paginated } from '../../shared/models/api.models';
import { AppNotification, NotificationPage } from '../../shared/models/payment.models';
import { RealtimeService } from './realtime.service';

const PAGE_SIZE = 20;

@Injectable({ providedIn: 'root' })
export class InboxService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly url = `${environment.apiUrl}/notifications`;

  readonly items = signal<AppNotification[]>([]);
  readonly unread = signal(0);
  readonly loaded = signal(false);
  private loading?: Subscription;

  constructor() {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
    const auth = inject(AuthService);
    // By id: a token refresh replaces the user object but not the person, so no reload.
    const userId = computed(() => auth.user()?.id);
    effect(() => {
      const id = userId();
      untracked(() => (id ? this.load() : this.clear()));
    });
    inject(RealtimeService)
      .notifications$.pipe(takeUntilDestroyed(inject(DestroyRef)))
      .subscribe((n) => {
        if (this.items().some((i) => i.id === n.id)) return;
        this.items.update((list) => [n, ...list].slice(0, PAGE_SIZE));
        if (!n.readAt) this.unread.update((u) => u + 1);
      });
  }

  load(): void {
    this.loading?.unsubscribe();
    this.loading = this.http
      .get<ApiResponse<NotificationPage>>(this.url, { params: { limit: PAGE_SIZE } })
      .pipe(map((r) => r.data))
      .subscribe({
        next: ({ items, unread }) => {
          this.items.set(items);
          this.unread.set(unread);
          this.loaded.set(true);
        },
        error: () => this.loaded.set(true),
      });
  }

  page(
    page: number,
    limit: number,
    unreadOnly: boolean,
  ): Observable<Paginated<AppNotification> & { unread: number }> {
    return this.http
      .get<ApiResponse<Paginated<AppNotification> & { unread: number }>>(this.url, {
        params: { page, limit, ...(unreadOnly && { unread: true }) },
      })
      .pipe(
        map((r) => r.data),
        tap((r) => this.unread.set(r.unread)),
      );
  }

  open(n: AppNotification): void {
    this.markRead(n);
    if (n.link) void this.router.navigateByUrl(n.link);
  }

  markRead(n: AppNotification): void {
    if (n.readAt) return;
    const readAt = new Date().toISOString();
    this.items.update((list) => list.map((i) => (i.id === n.id ? { ...i, readAt } : i)));
    this.unread.update((u) => Math.max(0, u - 1));
    this.http.patch(`${this.url}/${n.id}/read`, {}).subscribe({ error: () => this.load() });
  }

  markAllRead(): void {
    if (!this.unread()) return;
    const readAt = new Date().toISOString();
    this.items.update((list) => list.map((i) => (i.readAt ? i : { ...i, readAt })));
    this.unread.set(0);
    this.http.post(`${this.url}/read-all`, {}).subscribe({ error: () => this.load() });
  }

  clearAll(): Observable<unknown> {
    return this.http.delete(this.url).pipe(
      tap(() => {
        this.items.set([]);
        this.unread.set(0);
      }),
    );
  }

  private clear(): void {
    this.loading?.unsubscribe(); // a load still running must not refill the signed-out bell
    this.items.set([]);
    this.unread.set(0);
    this.loaded.set(false);
  }
}
