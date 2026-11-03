import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { AppNotification } from '../../shared/models/payment.models';
import { InboxService } from './inbox.service';
import { RealtimeService } from './realtime.service';

const note = (id: string, readAt: string | null = null): AppNotification => ({
  id,
  type: 'order.confirmed',
  title: `Order ${id} confirmed`,
  readAt,
  createdAt: '2026-11-03T10:00:00.000Z',
});

describe('InboxService', () => {
  const user = signal<{ id: string } | null>(null);
  const live = new Subject<AppNotification>();
  let http: HttpTestingController;
  let inbox: InboxService;

  beforeEach(() => {
    user.set(null);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { user } },
        { provide: RealtimeService, useValue: { notifications$: live.asObservable() } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    inbox = TestBed.inject(InboxService);
  });

  afterEach(() => http.verify());

  const signIn = () => {
    user.set({ id: 'u1' });
    TestBed.tick();
    http
      .expectOne((r) => r.url.endsWith('/notifications'))
      .flush({ success: true, message: 'OK', data: { items: [note('a'), note('b', '2026-11-03T09:00:00.000Z')], unread: 1 } });
  };

  it('loads on sign-in and clears on sign-out', () => {
    signIn();
    expect(inbox.items().length).toBe(2);
    expect(inbox.unread()).toBe(1);
    user.set(null);
    TestBed.tick();
    expect(inbox.items()).toEqual([]);
    expect(inbox.unread()).toBe(0);
  });

  it('adds live notifications once and counts them as unread', () => {
    signIn();
    live.next(note('c'));
    live.next(note('c'));
    expect(inbox.items().map((n) => n.id)).toEqual(['c', 'a', 'b']);
    expect(inbox.unread()).toBe(2);
  });

  it('marks read optimistically and reloads if the server refuses', () => {
    signIn();
    inbox.markRead(inbox.items()[0]);
    expect(inbox.unread()).toBe(0);
    expect(inbox.items()[0].readAt).not.toBeNull();
    http.expectOne((r) => r.url.endsWith('/notifications/a/read')).flush(null, { status: 500, statusText: 'Error' });
    http.expectOne((r) => r.url.endsWith('/notifications')).flush({ success: true, message: 'OK', data: { items: [note('a')], unread: 1 } });
    expect(inbox.unread()).toBe(1);
  });
});
