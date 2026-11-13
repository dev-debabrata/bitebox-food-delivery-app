import { isPlatformBrowser } from '@angular/common';
import { DestroyRef, Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { isStandaloneApp, storageGet, storageSet } from './browser-storage';
import { DevicePlatformInfo, detectPlatform } from './platform-detector';
import { InstallDialog } from '../../shared/components/install-dialog/install-dialog';

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DISMISSED_KEY = 'bb.install.dismissedAt';
const INSTALLED_KEY = 'bb.install.done';
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class InstallPromptService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly dialog = inject(MatDialog);

  private readonly deferred = signal<BeforeInstallPromptEvent | null>(null);
  private readonly _installed = signal(false);
  private readonly _justInstalled = signal(false);
  // Default to snoozed (true) so SSR never renders the banner into the initial HTML.
  // The client constructor checks localStorage and enables the banner only if not snoozed.
  private readonly snoozed = signal(true);

  readonly platform = signal<DevicePlatformInfo>(detectPlatform());
  readonly hasNativePrompt = computed(() => !!this.deferred());
  readonly installed = this._installed.asReadonly();
  readonly justInstalled = this._justInstalled.asReadonly();
  readonly canInstall = computed(() => !this._installed());
  readonly showBanner = computed(() => this.canInstall() && !this.snoozed());

  constructor() {
    if (!isPlatformBrowser(this.platformId)) return;
    this.platform.set(detectPlatform());
    const standalone = isStandaloneApp();
    const isInstalled = standalone || storageGet(INSTALLED_KEY) === '1';
    this._installed.set(isInstalled);

    const dismissedAt = Number(storageGet(DISMISSED_KEY) || 0);
    const isSnoozed = dismissedAt > 0 && Date.now() - dismissedAt < SNOOZE_MS;
    this.snoozed.set(isSnoozed);

    const onPrompt = (event: Event) => {
      event.preventDefault();
      this.deferred.set(event as BeforeInstallPromptEvent);
      if (!standalone) this._installed.set(false);
    };

    const onInstalled = () => {
      this.deferred.set(null);
      this.markInstalled();
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    });
  }

  async install(): Promise<boolean> {
    const event = this.deferred();
    if (!event) {
      this.showInstructions();
      return false;
    }

    this.deferred.set(null);
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome === 'accepted') {
      this.markInstalled();
      return true;
    }
    this.dismiss();
    return false;
  }

  private markInstalled(): void {
    this._installed.set(true);
    storageSet(INSTALLED_KEY, '1');
    this._justInstalled.set(true);
    setTimeout(() => this._justInstalled.set(false), 6000);
  }

  showInstructions(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    this.dialog.open(InstallDialog, {
      width: '560px',
      maxWidth: '95vw',
      panelClass: 'bb-install-dialog-panel',
      autoFocus: 'first-tabbable',
    });
  }

  dismiss(): void {
    this.snoozed.set(true);
    storageSet(DISMISSED_KEY, String(Date.now()));
    try {
      document.cookie = `${DISMISSED_KEY}=1; path=/; max-age=2592000; SameSite=Lax`;
    } catch {
      // Cookie unavailable
    }
  }
}
