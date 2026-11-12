import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { ApplicationRef, DestroyRef, Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate } from '@angular/service-worker';
import { filter, first } from 'rxjs';

/** How often an open tab asks the server whether a new version was deployed. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** Coming back to the tab checks again, but not more often than this. */
const MIN_GAP_MS = 30 * 60 * 1000;

/**
 * New-version detection through the Angular service worker. When a new build has been
 * downloaded, `available` turns true and the UI offers "Update now"; nothing reloads on its
 * own, so nobody loses a half-filled checkout. `broken` means the cached version can no
 * longer be served (a reload fixes it).
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private readonly updates = inject(SwUpdate);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  readonly available = signal(false);
  readonly broken = signal(false);
  readonly updating = signal(false);
  private lastCheck = 0;

  constructor() {
    if (!isPlatformBrowser(inject(PLATFORM_ID)) || !this.updates.isEnabled) return;

    this.updates.versionUpdates
      .pipe(
        filter((e) => e.type === 'VERSION_READY'),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.available.set(true));
    this.updates.unrecoverable.pipe(takeUntilDestroyed()).subscribe(() => this.broken.set(true));

    // Start polling once the app has settled, so it never delays the first render.
    inject(ApplicationRef)
      .isStable.pipe(first(Boolean))
      .subscribe(() => {
        void this.check();
        const timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
        const onVisible = () => {
          if (this.document.visibilityState === 'visible' && Date.now() - this.lastCheck > MIN_GAP_MS)
            void this.check();
        };
        this.document.addEventListener('visibilitychange', onVisible);
        this.destroyRef.onDestroy(() => {
          clearInterval(timer);
          this.document.removeEventListener('visibilitychange', onVisible);
        });
      });
  }

  private async check(): Promise<void> {
    if (!navigator.onLine) return;
    this.lastCheck = Date.now();
    try {
      await this.updates.checkForUpdate();
    } catch {
      // Offline or the server is unreachable: try again next time.
    }
  }

  /** Switches to the downloaded version and reloads once (the user asked for it). */
  async applyUpdate(): Promise<void> {
    if (this.updating()) return;
    this.updating.set(true);
    try {
      await this.updates.activateUpdate(); // only offered while the worker is enabled
    } finally {
      this.document.location.reload();
    }
  }

  dismiss(): void {
    this.available.set(false);
  }

  reload(): void {
    this.document.location.reload();
  }
}
