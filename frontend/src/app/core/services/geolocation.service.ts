import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export interface Coordinates {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

export const UNRELIABLE_ACCURACY_M = 2000;

export const MAX_USABLE_ACCURACY_M = 1000;

export class ImpreciseLocationError extends Error {
  constructor(readonly accuracyMeters: number) {
    super(
      "We couldn't detect your exact location on this device. Please search for your area or a nearby landmark.",
    );
    this.name = 'ImpreciseLocationError';
  }
}

@Injectable({ providedIn: 'root' })
export class GeolocationService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  get supported(): boolean {
    return this.isBrowser && 'geolocation' in navigator;
  }

  async currentPrecise(): Promise<Coordinates> {
    const position = await this.current();
    if (position.accuracy !== undefined && position.accuracy > MAX_USABLE_ACCURACY_M) {
      throw new ImpreciseLocationError(position.accuracy);
    }
    return position;
  }

  current(): Promise<Coordinates> {
    if (!this.supported)
      return Promise.reject(new Error('Location is not available in this browser.'));
    return new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(
        ({ coords }) =>
          resolve({
            latitude: coords.latitude,
            longitude: coords.longitude,
            accuracy: coords.accuracy,
          }),
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
        { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
      ),
    );
  }
}
