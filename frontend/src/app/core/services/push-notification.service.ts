import { HttpClient } from '@angular/common/http';
import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { SwPush } from '@angular/service-worker';
import { Observable, firstValueFrom, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api.models';
import { AuthService } from '../auth/auth.service';
import { isStandaloneApp, storageGet, storageSet } from './browser-storage';
import { inBackground } from './page-loader';

export type PushCategory = 'orders' | 'account' | 'promotions';
export type PushPreferences = Record<PushCategory, boolean>;

export interface PushSettings {
  preferences: PushPreferences;
  /** The switches that apply to this account (promotions are for customers only). */
  categories: PushCategory[];
  /** Browsers subscribed for this account. */
  devices: number;
  /** Push is configured on the server. */
  enabled: boolean;
}

/** Why push cannot be offered here (null when it can). */
export type PushBlocker =
  | 'unsupported' // no service worker / Push API (or a development build)
  | 'ios-browser' // iOS Safari: only the Home Screen app can receive pushes
  | 'denied' // the person blocked notifications for this site
  | null;

/** Which account turned push on in this browser (so it resumes after signing back in). */
const OPT_IN_KEY = 'bb.push.optIn';
/** "<user> <endpoint> <time>" of the last registration, so sign-ins re-register at most daily. */
const SYNCED_KEY = 'bb.push.synced';
const RESYNC_MS = 24 * 60 * 60 * 1000;

/**
 * Browser push notifications through the Angular service worker (SwPush). The permission
 * prompt is only ever shown from `enable()`, which must run from a click. The VAPID public key
 * comes from the API; the private key never reaches the browser.
 *
 * On sign-out the browser unsubscribes, so a shared device never receives the previous
 * person's notifications (the server forgets the endpoint on its next send).
 */
@Injectable({ providedIn: 'root' })
export class PushNotificationService {
  private readonly http = inject(HttpClient);
  private readonly swPush = inject(SwPush);
  private readonly auth = inject(AuthService);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly url = `${environment.baseUrl}/push`;
  private config?: Promise<{ enabled: boolean; publicKey: string | null }>;

  /** The Push API and the service worker are available in this browser. */
  readonly supported =
    this.browser && this.swPush.isEnabled && typeof Notification !== 'undefined' && 'PushManager' in window;

  readonly permission = signal<NotificationPermission>(
    this.browser && typeof Notification !== 'undefined' ? Notification.permission : 'default',
  );
  /** Never emits while the service worker is disabled (server, development builds). */
  private readonly subscription = toSignal(this.swPush.subscription, { initialValue: null });
  /** This browser is subscribed. */
  readonly subscribed = computed(() => !!this.subscription() && this.permission() === 'granted');
  readonly busy = signal(false);

  readonly blocker = computed<PushBlocker>(() => {
    if (!this.supported)
      return this.browser && /iPad|iPhone|iPod/.test(navigator.userAgent) && !isStandaloneApp()
        ? 'ios-browser'
        : 'unsupported';
    return this.permission() === 'denied' ? 'denied' : null;
  });

  constructor() {
    if (!this.supported) return;
    const userId = computed(() => this.auth.user()?.id ?? null);
    let previous: string | null = null;
    effect(() => {
      const id = userId();
      untracked(() => {
        if (id) void this.resume(id);
        else if (previous) void this.swPush.unsubscribe().catch(() => undefined);
        previous = id;
      });
    });
  }

  /** Push is configured on the server (cached; the key never changes while the app runs). */
  async available(): Promise<boolean> {
    return (await this.publicConfig()).enabled;
  }

  /** Asks for permission (click only), subscribes this browser and registers it with the API. */
  async enable(): Promise<void> {
    if (!this.supported) throw new Error('Push notifications are not supported in this browser.');
    this.busy.set(true);
    try {
      if (!(await this.subscribeAndRegister()))
        throw new Error('Notifications are not available right now.');
      storageSet(OPT_IN_KEY, this.auth.user()?.id ?? null);
    } finally {
      this.permission.set(Notification.permission);
      this.busy.set(false);
    }
  }

  /** Stops pushes to this browser (the API row and the browser subscription). */
  async disable(): Promise<void> {
    this.busy.set(true);
    try {
      const sub = this.subscription();
      // Best-effort: the browser unsubscribe below stops delivery anyway.
      if (sub)
        await firstValueFrom(
          this.http.delete(`${this.url}/subscriptions`, { body: { endpoint: sub.endpoint } }),
        ).catch(() => undefined);
      await this.swPush.unsubscribe().catch(() => undefined);
      storageSet(OPT_IN_KEY, null);
    } finally {
      this.busy.set(false);
    }
  }

  settings(): Promise<PushSettings> {
    return this.data(this.http.get<ApiResponse<PushSettings>>(`${this.url}/preferences`));
  }

  savePreferences(changes: Partial<PushPreferences>): Promise<PushSettings> {
    return this.data(this.http.put<ApiResponse<PushSettings>>(`${this.url}/preferences`, changes));
  }

  private data<T>(request: Observable<ApiResponse<T>>): Promise<T> {
    return firstValueFrom(request.pipe(map((r) => r.data)));
  }

  private publicConfig() {
    this.config ??= this.data(
      this.http.get<ApiResponse<{ enabled: boolean; publicKey: string | null }>>(`${this.url}/public-key`),
    ).catch((error) => {
      this.config = undefined; // retry next time
      throw error;
    });
    return this.config;
  }

  /** Subscribes this browser (prompting if needed) and registers it. False when push is off. */
  private async subscribeAndRegister(): Promise<boolean> {
    const { enabled, publicKey } = await this.publicConfig();
    if (!enabled || !publicKey) return false;
    await this.register(await this.swPush.requestSubscription({ serverPublicKey: publicKey }));
    return true;
  }

  private async register(sub: PushSubscription): Promise<void> {
    await firstValueFrom(inBackground(this.http.post(`${this.url}/subscriptions`, sub.toJSON())));
    storageSet(SYNCED_KEY, `${this.auth.user()?.id} ${sub.endpoint} ${Date.now()}`);
  }

  /**
   * After sign-in: keeps the server's record of this browser pointing at the signed-in
   * account (at most once a day). Re-subscribes silently only if this same account had turned
   * push on here and permission is still granted (no prompt is shown).
   */
  private async resume(userId: string): Promise<void> {
    this.permission.set(Notification.permission);
    if (Notification.permission !== 'granted') return;
    const mine = storageGet(OPT_IN_KEY) === userId;
    try {
      const existing = this.subscription() ?? (await firstValueFrom(this.swPush.subscription));
      if (!existing) {
        if (mine) await this.subscribeAndRegister();
      } else if (!mine) {
        await this.swPush.unsubscribe(); // someone else's subscription on a shared browser
      } else {
        const [user, endpoint, at] = (storageGet(SYNCED_KEY) ?? '').split(' ');
        if (user !== userId || endpoint !== existing.endpoint || Date.now() - Number(at) > RESYNC_MS)
          await this.register(existing);
      }
    } catch {
      // Offline or the push service refused: the settings page still offers "Turn on".
    }
  }
}
