import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export interface Coordinates {
  latitude: number;
  longitude: number;
  /** Radius in metres within which the true position probably lies. */
  accuracy?: number;
}

/**
 * Above this the position is only a rough network guess (desktop browsers can
 * report accuracies of hundreds of km). Treat it as a starting point at best.
 */
export const UNRELIABLE_ACCURACY_M = 2000;

/**
 * "Current location" is only used when the browser is at least this sure.
 * Phones (GPS) and Wi-Fi laptops are usually within tens of metres; desktops
 * on wired/IP-only connections often report kilometres or more, which would
 * put the customer in the wrong neighbourhood.
 */
export const MAX_USABLE_ACCURACY_M = 1000;

/** The browser answered, but too vaguely to use for delivery. */
export class ImpreciseLocationError extends Error {
  constructor(readonly accuracyMeters: number) {
    super("We couldn't detect your exact location on this device. Please search for your area or a nearby landmark.");
    this.name = 'ImpreciseLocationError';
  }
}

/** Thin wrapper over the browser Geolocation API with user-friendly error messages. */
@Injectable({ providedIn: 'root' })
export class GeolocationService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  get supported(): boolean {
    return this.isBrowser && 'geolocation' in navigator;
  }

  /**
   * Current position, but only if it is precise enough to deliver to
   * (see MAX_USABLE_ACCURACY_M). Rejects with ImpreciseLocationError otherwise.
   */
  async currentPrecise(): Promise<Coordinates> {
    const position = await this.current();
    if (position.accuracy !== undefined && position.accuracy > MAX_USABLE_ACCURACY_M) {
      throw new ImpreciseLocationError(position.accuracy);
    }
    return position;
  }

  current(): Promise<Coordinates> {
    if (!this.supported) return Promise.reject(new Error('Location is not available in this browser.'));
    return new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }),
        (error) =>
          reject(
            new Error(
              error.code === error.PERMISSION_DENIED
                ? 'Location permission was denied. Allow it in your browser settings to see nearby restaurants.'
                : error.code === error.TIMEOUT
                  ? 'Getting your location took too long. Please try again.'
                  : 'Your location is unavailable right now.',
            ),
          ),
        // Ask for the best fix available and never reuse a cached position.
        { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
      ),
    );
  }
}
