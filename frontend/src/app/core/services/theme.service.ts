import {
  DOCUMENT,
  DestroyRef,
  Injectable,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { storageGet, storageSet } from './browser-storage';

export type Theme = 'light' | 'dark';
/** What the user picked; `system` follows the device setting. */
export type ThemePreference = Theme | 'system';

/** localStorage key; the inline script in index.html reads it too, so keep both in sync. */
export const THEME_STORAGE_KEY = 'bb-theme';

/** `<meta name="theme-color">` per theme: the browser and installed-app title bar. */
const META_COLOR: Record<Theme, string> = { light: '#ffffff', dark: '#120c17' };

const isPreference = (value: string | null): value is ThemePreference =>
  value === 'light' || value === 'dark' || value === 'system';

/**
 * Light or dark theme. Sets `data-theme` on `<html>`, which both the BiteBox tokens
 * (styles.scss) and NexPrime read. index.html applies the stored choice before the first
 * paint, so this service only keeps it up to date afterwards. On the server it does nothing,
 * and the page renders light.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly preference = signal<ThemePreference>('system');
  private readonly systemDark = signal(false);

  /** The theme in effect now. */
  readonly theme = computed<Theme>(() => {
    const preference = this.preference();
    if (preference !== 'system') return preference;
    return this.systemDark() ? 'dark' : 'light';
  });

  constructor() {
    if (!this.browser) return;

    const stored = storageGet(THEME_STORAGE_KEY);
    if (isPreference(stored)) this.preference.set(stored);

    const query = this.document.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
    if (query) {
      this.systemDark.set(query.matches);
      const onChange = (event: MediaQueryListEvent) => this.systemDark.set(event.matches);
      query.addEventListener?.('change', onChange);
      inject(DestroyRef).onDestroy(() => query.removeEventListener?.('change', onChange));
    }

    effect(() => this.apply(this.theme()));
  }

  /** Switch to the other theme and remember it (an explicit choice, no longer "system"). */
  toggle(): void {
    this.setPreference(this.theme() === 'dark' ? 'light' : 'dark');
  }

  setPreference(preference: ThemePreference): void {
    this.preference.set(preference);
    if (this.browser) storageSet(THEME_STORAGE_KEY, preference === 'system' ? null : preference);
  }

  private apply(theme: Theme): void {
    const root = this.document.documentElement;
    root.setAttribute('data-theme', theme);
    this.document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', META_COLOR[theme]);
  }
}
