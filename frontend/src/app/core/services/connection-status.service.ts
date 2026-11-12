import { DestroyRef, Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

const RESTORED_MS = 4000;

/**
 * Online/offline status of the browser. `online` follows the `online`/`offline` events
 * (navigator.onLine); `restored` is briefly true after the connection comes back, for a
 * "Back online" message. Always online on the server.
 */
@Injectable({ providedIn: 'root' })
export class ConnectionStatus {
  private readonly _online = signal(true);
  private readonly _restored = signal(false);
  readonly online = this._online.asReadonly();
  readonly restored = this._restored.asReadonly();

  constructor() {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
    this._online.set(navigator.onLine);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const online = navigator.onLine;
      if (online === this._online()) return;
      this._online.set(online);
      clearTimeout(timer);
      this._restored.set(online);
      if (online) timer = setTimeout(() => this._restored.set(false), RESTORED_MS);
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(timer);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    });
  }
}
