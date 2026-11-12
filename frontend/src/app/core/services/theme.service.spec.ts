import { TestBed } from '@angular/core/testing';
import { THEME_STORAGE_KEY, ThemeService } from './theme.service';

describe('ThemeService', () => {
  let systemDark: boolean;
  let listeners: ((event: MediaQueryListEvent) => void)[];

  const html = () => document.documentElement;
  const metaColor = () =>
    document.querySelector('meta[name="theme-color"]')?.getAttribute('content');

  beforeEach(() => {
    localStorage.clear();
    html().removeAttribute('data-theme');
    document.head.querySelector('meta[name="theme-color"]')?.remove();
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#ffffff';
    document.head.append(meta);

    systemDark = false;
    listeners = [];
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: systemDark,
      addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.push(fn),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  });

  it('follows the device setting when nothing is stored', () => {
    systemDark = true;
    const theme = TestBed.inject(ThemeService);
    TestBed.tick();
    expect(theme.preference()).toBe('system');
    expect(theme.theme()).toBe('dark');
    expect(html().getAttribute('data-theme')).toBe('dark');
    expect(metaColor()).toBe('#120c17');
  });

  it('reacts when the device switches while the app is open', () => {
    const theme = TestBed.inject(ThemeService);
    TestBed.tick();
    expect(theme.theme()).toBe('light');

    listeners.forEach((fn) => fn({ matches: true } as MediaQueryListEvent));
    TestBed.tick();
    expect(html().getAttribute('data-theme')).toBe('dark');
  });

  it('uses and keeps an explicit choice over the device setting', () => {
    systemDark = true;
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const theme = TestBed.inject(ThemeService);
    TestBed.tick();
    expect(theme.theme()).toBe('light');

    listeners.forEach((fn) => fn({ matches: true } as MediaQueryListEvent));
    TestBed.tick();
    expect(html().getAttribute('data-theme')).toBe('light');
  });

  it('toggle() switches theme and remembers it; "system" forgets the choice', () => {
    const theme = TestBed.inject(ThemeService);
    theme.toggle();
    TestBed.tick();
    expect(theme.theme()).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(html().getAttribute('data-theme')).toBe('dark');

    theme.setPreference('system');
    TestBed.tick();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(theme.theme()).toBe('light');
  });

  it('ignores an unknown stored value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    const theme = TestBed.inject(ThemeService);
    expect(theme.preference()).toBe('system');
  });
});
