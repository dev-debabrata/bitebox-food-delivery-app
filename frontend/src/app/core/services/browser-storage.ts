/**
 * localStorage that never throws (private mode, storage disabled, server rendering).
 * `storageSet(key, null)` removes the key.
 */
export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not persisted: the preference simply isn't remembered.
  }
}

/** Running as the installed app (its own window), not in a browser tab. Browser only. */
export const isStandaloneApp = (): boolean =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
