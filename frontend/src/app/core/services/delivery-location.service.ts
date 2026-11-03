import { HttpClient } from '@angular/common/http';
import { Injectable, PLATFORM_ID, afterNextRender, effect, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Observable, firstValueFrom, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api.models';
import { DeliveryAddress } from '../../shared/models/checkout.models';
import { toParams } from './http-params';
import { GeolocationService } from './geolocation.service';

export interface Place {
  label: string;
  displayName?: string;
  latitude: number;
  longitude: number;
  street?: string | null;
  building?: string | null;
  area?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}

export interface ExtractedAddress {
  line1: string;
  line2: string;
  area: string;
  city: string;
  state: string;
  postalCode: string;
}

/**
 * Extracts structured address parts (line1, line2, area, city, state, postal code)
 * from a Place object, separating street/building details from city/state/country.
 */
export function extractAddressFromPlace(place: Place): ExtractedAddress {
  const parts = (place.displayName || place.label || '').split(',').map((s) => s.trim()).filter(Boolean);
  const tail = new Set(['india', place.postalCode?.toLowerCase(), place.state?.toLowerCase(), place.city?.toLowerCase()].filter(Boolean));

  const streetParts: string[] = [];
  for (const p of parts) {
    if (tail.has(p.toLowerCase())) break;
    streetParts.push(p);
  }

  const line1 = streetParts.length ? streetParts.join(', ') : place.label || '';
  const candidate = streetParts.length > 1 && streetParts[0] !== place.area ? streetParts[0] : '';
  const line2 = place.building || (/^\d+[A-Za-z]?$/.test(streetParts[1] ?? '') ? streetParts[1] : candidate);

  return {
    line1: line1.slice(0, 120),
    line2: (line2 !== line1 ? line2 : '').slice(0, 120),
    area: (place.area || streetParts.at(-1) || '').slice(0, 80),
    city: (place.city || '').slice(0, 80),
    state: (place.state || '').slice(0, 80),
    postalCode: (place.postalCode || '').slice(0, 10),
  };
}

export interface DeliveryLocation {
  label: string;
  detail?: string;
  latitude: number;
  longitude: number;
  source: 'gps' | 'search' | 'address';
  addressId?: string;
}

const STORAGE_KEY = 'bb_delivery_location';

/**
 * Where the visitor wants food delivered. Drives "restaurants near you" on the
 * home page and restaurant list. Stored in localStorage on this device only;
 * it is not sensitive and is never sent anywhere except as search coordinates.
 */
@Injectable({ providedIn: 'root' })
export class DeliveryLocationService {
  private readonly http = inject(HttpClient);
  private readonly geo = inject(GeolocationService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly api = `${environment.apiUrl}/geo`;

  /**
   * Starts empty everywhere so server-rendered HTML and the browser's first
   * render match (hydration); the saved choice is restored right after.
   */
  readonly location = signal<DeliveryLocation | null>(null);
  private restored = false;

  constructor() {
    if (!this.isBrowser) return;
    afterNextRender(() => {
      const saved = this.restore();
      this.restored = true;
      if (saved && !this.location()) this.location.set(saved);
    });
    effect(() => {
      const value = this.location();
      if (!this.restored) return;
      try {
        if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
        else localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Storage can be unavailable (private mode); the choice then lasts for this visit only.
      }
    });
  }

  search(query: string): Observable<Place[]> {
    return this.http.get<ApiResponse<{ places: Place[] }>>(`${this.api}/search`, { params: toParams({ q: query }) }).pipe(map((r) => r.data.places));
  }

  /** Coordinates -> address parts (area, city, state, PIN), via the API's cached geocoder. */
  reverse(latitude: number, longitude: number): Observable<Place> {
    return this.http
      .get<ApiResponse<{ place: Place }>>(`${this.api}/reverse`, { params: toParams({ lat: latitude, lng: longitude }) })
      .pipe(map((r) => r.data.place));
  }

  /** Browser GPS -> readable place name. Falls back to coordinates if naming fails. */
  async useCurrentLocation(): Promise<DeliveryLocation> {
    const { latitude, longitude } = await this.geo.currentPrecise();
    let label = 'Current location';
    let detail: string | undefined;
    try {
      const place = await firstValueFrom(
        this.http
          .get<ApiResponse<{ place: Place }>>(`${this.api}/reverse`, { params: toParams({ lat: latitude, lng: longitude }) })
          .pipe(map((r) => r.data.place)),
      );
      label = place.label || label;
      detail = place.displayName;
    } catch {
      detail = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
    }
    const location: DeliveryLocation = { label, detail, latitude, longitude, source: 'gps' };
    this.location.set(location);
    return location;
  }

  /** A point the user confirmed on the map (after GPS, search, or dragging the pin). */
  choosePoint(point: { latitude: number; longitude: number; label: string; detail?: string; source: DeliveryLocation['source'] }): void {
    this.location.set({ ...point });
  }

  choosePlace(place: Place): void {
    this.location.set({ label: place.label, detail: place.displayName, latitude: place.latitude, longitude: place.longitude, source: 'search' });
  }

  chooseAddress(address: DeliveryAddress): void {
    const [longitude, latitude] = address.location.coordinates;
    this.location.set({
      label: [address.area, address.city].filter(Boolean).join(', ') || address.line1,
      detail: [address.line1, address.city].filter(Boolean).join(', '),
      latitude,
      longitude,
      source: 'address',
      addressId: address.id,
    });
  }

  clear(): void {
    this.location.set(null);
  }

  private restore(): DeliveryLocation | null {
    if (!this.isBrowser) return null;
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as DeliveryLocation | null;
      const valid =
        raw &&
        typeof raw.label === 'string' &&
        Number.isFinite(raw.latitude) &&
        Number.isFinite(raw.longitude) &&
        Math.abs(raw.latitude) <= 90 &&
        Math.abs(raw.longitude) <= 180;
      return valid ? raw : null;
    } catch {
      return null;
    }
  }
}
