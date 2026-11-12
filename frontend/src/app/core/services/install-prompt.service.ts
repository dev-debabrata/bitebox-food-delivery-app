import { isPlatformBrowser } from '@angular/common';
import { DestroyRef, Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isStandaloneApp, storageGet, storageSet } from './browser-storage';

/** The non-standard event Chromium browsers fire when the app can be installed. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DISMISSED_KEY = 'bb.install.dismissedAt';
const INSTALLED_KEY = 'bb.install.done';
/** "Not now" hides the promotional banner for this long (the menu item stays). */
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * "Install app": keeps the browser's install prompt (`beforeinstallprompt`) for a button to
 * show later, and remembers once BiteBox is installed (`appinstalled`) so it never asks again.
 * Browsers without the event (Safari, Firefox) simply never show the install UI; their own
 * menus still offer "Add to Home Screen".
 */
@Injectable({ providedIn: 'root' })
export class InstallPromptService {
  private readonly deferred = signal<BeforeInstallPromptEvent | null>(null);
  private readonly _installed = signal(false);
  private readonly _justInstalled = signal(false);
  private readonly snoozed = signal(false);

  /** The app is running as the installed app (standalone window), or was just installed. */
  readonly installed = this._installed.asReadonly();
  /** Briefly true after installing, for a confirmation message (app-status). */
  readonly justInstalled = this._justInstalled.asReadonly();
  /** The browser can show its install dialog right now. */
  readonly canInstall = computed(() => !!this.deferred() && !this._installed());
  /** The promotional banner: installable, not installed, not snoozed. */
  readonly showBanner = computed(() => this.canInstall() && !this.snoozed());

  constructor() {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
    const standalone = isStandaloneApp();
    this._installed.set(standalone || storageGet(INSTALLED_KEY) === '1');
    this.snoozed.set(Date.now() - Number(storageGet(DISMISSED_KEY) || 0) < SNOOZE_MS);

    const onPrompt = (event: Event) => {
      // Keep it for our own button instead of the browser's mini-infobar.
      event.preventDefault();
      this.deferred.set(event as BeforeInstallPromptEvent);
      // The browser only offers it when BiteBox is not installed (it may have been removed).
      if (!standalone) {
        this._installed.set(false);
        storageSet(INSTALLED_KEY, null);
      }
    };
    const onInstalled = () => {
      this.deferred.set(null);
      this._installed.set(true);
      storageSet(INSTALLED_KEY, '1');
      this._justInstalled.set(true);
      setTimeout(() => this._justInstalled.set(false), 6000);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    });
  }

  /** Opens the browser's install dialog. Must be called from a click. */
  async install(): Promise<boolean> {
    const event = this.deferred();
    if (!event) return false;
    this.deferred.set(null); // a prompt can only be used once
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome === 'dismissed') this.dismiss();
    return outcome === 'accepted';
  }

  /** "Not now" on the banner. */
  dismiss(): void {
    this.snoozed.set(true);
    storageSet(DISMISSED_KEY, String(Date.now()));
  }
}
