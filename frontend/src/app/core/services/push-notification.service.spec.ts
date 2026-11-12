import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import { BehaviorSubject } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { PushNotificationService } from './push-notification.service';

const fakeSubscription = (endpoint = 'https://fcm.googleapis.com/fcm/send/abc') =>
  ({
    endpoint,
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }),
  }) as unknown as PushSubscription;

describe('PushNotificationService', () => {
  const user = signal<{ id: string; role: string } | null>(null);
  let subscription$: BehaviorSubject<PushSubscription | null>;
  let swPush: {
    isEnabled: boolean;
    subscription: BehaviorSubject<PushSubscription | null>;
    requestSubscription: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
  };
  let permission: NotificationPermission;
  let http: HttpTestingController;

  const setup = ({ enabled = true } = {}) => {
    subscription$ = new BehaviorSubject<PushSubscription | null>(null);
    swPush = {
      isEnabled: enabled,
      subscription: subscription$,
      requestSubscription: vi.fn(async () => {
        permission = 'granted';
        const sub = fakeSubscription();
        subscription$.next(sub);
        return sub;
      }),
      unsubscribe: vi.fn(async () => subscription$.next(null)),
    };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: SwPush, useValue: swPush },
        { provide: AuthService, useValue: { user } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    return TestBed.inject(PushNotificationService);
  };

  beforeEach(() => {
    localStorage.clear();
    user.set(null);
    permission = 'default';
    vi.stubGlobal('Notification', {
      get permission() {
        return permission;
      },
    });
    (window as unknown as { PushManager: unknown }).PushManager = function PushManager() {};
  });

  afterEach(() => {
    http.verify();
    vi.unstubAllGlobals();
    delete (window as unknown as { PushManager?: unknown }).PushManager;
  });

  it('explains why push is unavailable without a service worker', () => {
    const push = setup({ enabled: false });
    expect(push.supported).toBe(false);
    expect(push.blocker()).toBe('unsupported');
  });

  it('reports a blocked permission', () => {
    permission = 'denied';
    const push = setup();
    expect(push.blocker()).toBe('denied');
  });

  it('subscribes with the public key from the API and registers the browser', async () => {
    const push = setup();
    user.set({ id: 'u1', role: 'customer' });
    TestBed.tick(); // permission is "default": nothing happens on sign-in

    const done = push.enable();
    const key = http.expectOne((r) => r.url.endsWith('/push/public-key'));
    key.flush({ success: true, message: 'OK', data: { enabled: true, publicKey: 'BPublicKey' } });
    await vi.waitFor(() => expect(swPush.requestSubscription).toHaveBeenCalledWith({ serverPublicKey: 'BPublicKey' }));
    const register = await vi.waitFor(() => http.expectOne((r) => r.url.endsWith('/push/subscriptions')));
    expect(register.request.method).toBe('POST');
    expect(register.request.body.endpoint).toContain('fcm.googleapis.com');
    register.flush({ success: true, message: 'OK', data: {} });
    await done;

    expect(push.subscribed()).toBe(true);
    expect(localStorage.getItem('bb.push.optIn')).toBe('u1');
  });

  it('unsubscribes this browser when the person signs out', async () => {
    permission = 'granted';
    localStorage.setItem('bb.push.optIn', 'u1');
    setup();
    subscription$.next(fakeSubscription());
    user.set({ id: 'u1', role: 'customer' });
    TestBed.tick();
    // Signing in re-links the existing subscription to this account.
    (await vi.waitFor(() => http.expectOne((r) => r.url.endsWith('/push/subscriptions')))).flush({
      success: true,
      message: 'OK',
      data: {},
    });

    user.set(null);
    TestBed.tick();
    await vi.waitFor(() => expect(swPush.unsubscribe).toHaveBeenCalled());
  });

  it("drops another account's subscription on a shared browser instead of re-linking it", async () => {
    permission = 'granted';
    localStorage.setItem('bb.push.optIn', 'someone-else');
    setup();
    subscription$.next(fakeSubscription());
    user.set({ id: 'u2', role: 'customer' });
    TestBed.tick();
    await vi.waitFor(() => expect(swPush.unsubscribe).toHaveBeenCalled());
    http.expectNone((r) => r.url.endsWith('/push/subscriptions'));
  });
});
