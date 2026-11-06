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

export function extractAddressFromPlace(place: Place): ExtractedAddress {
  const parts = (place.displayName || place.label || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const tail = new Set(
    [
      'india',
      place.postalCode?.toLowerCase(),
      place.state?.toLowerCase(),
      place.city?.toLowerCase(),
    ].filter(Boolean),
  );

  const streetParts: string[] = [];
  for (const p of parts) {
    if (tail.has(p.toLowerCase())) break;
    streetParts.push(p);
  }

  const line1 = streetParts.length ? streetParts.join(', ') : place.label || '';
  const candidate = streetParts.length > 1 && streetParts[0] !== place.area ? streetParts[0] : '';
  const line2 =
    place.building || (/^\d+[A-Za-z]?$/.test(streetParts[1] ?? '') ? streetParts[1] : candidate);

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

@Injectable({ providedIn: 'root' })
export class DeliveryLocationService {
  private readonly http = inject(HttpClient);
  private readonly geo = inject(GeolocationService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly api = `${environment.apiUrl}/geo`;

  readonly location = signal<DeliveryLocation | null>(null);
  /**
   * True once the saved location has been read (always on the server, which has none). Screens
   * that load by location wait for it, so they don't fetch once without it and again with it.
   */
  readonly ready = signal(!this.isBrowser);

  constructor() {
    if (!this.isBrowser) return;
    afterNextRender(() => {
      const saved = this.restore();
      if (saved && !this.location()) this.location.set(saved);
      this.ready.set(true);
    });
    effect(() => {
      const value = this.location();
      if (!this.ready()) return;
      try {
        if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
        else localStorage.removeItem(STORAGE_KEY);
      } catch {}
    });
  }

  search(query: string): Observable<Place[]> {
    return this.http
      .get<ApiResponse<{ places: Place[] }>>(`${this.api}/search`, {
        params: toParams({ q: query }),
      })
      .pipe(map((r) => r.data.places));
  }

  reverse(latitude: number, longitude: number): Observable<Place> {
    return this.http
      .get<ApiResponse<{ place: Place }>>(`${this.api}/reverse`, {
        params: toParams({ lat: latitude, lng: longitude }),
      })
      .pipe(map((r) => r.data.place));
  }

  async useCurrentLocation(): Promise<DeliveryLocation> {
    const { latitude, longitude } = await this.geo.currentPrecise();
    let label = 'Current location';
    let detail: string | undefined;
    try {
      const place = await firstValueFrom(
        this.http
          .get<ApiResponse<{ place: Place }>>(`${this.api}/reverse`, {
            params: toParams({ lat: latitude, lng: longitude }),
          })
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

  choosePoint(point: {
    latitude: number;
    longitude: number;
    label: string;
    detail?: string;
    source: DeliveryLocation['source'];
  }): void {
    this.location.set({ ...point });
  }

  choosePlace(place: Place): void {
    this.location.set({
      label: place.label,
      detail: place.displayName,
      latitude: place.latitude,
      longitude: place.longitude,
      source: 'search',
    });
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

  /** Drops a saved address that no longer exists; the point itself stays as the location. */
  forgetAddress(addressId: string): void {
    const current = this.location();
    if (current?.addressId === addressId) {
      this.location.set({ ...current, source: 'search', addressId: undefined });
    }
  }

  private restore(): DeliveryLocation | null {
    if (!this.isBrowser) return null;
    try {
      const raw = JSON.parse(
        localStorage.getItem(STORAGE_KEY) ?? 'null',
      ) as DeliveryLocation | null;
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
