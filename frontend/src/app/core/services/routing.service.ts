import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of, shareReplay } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api.models';

export interface Point {
  latitude: number;
  longitude: number;
}

export interface RoadRoute {
  distanceMeters: number;
  durationSeconds: number;
  straightLineMeters: number;
  path: Point[];
  provider: string;
  attribution: string;
  estimate: true;
}

export function isValidPoint(p: Partial<Point> | null | undefined): p is Point {
  return (
    !!p &&
    Number.isFinite(p.latitude) &&
    Number.isFinite(p.longitude) &&
    Math.abs(p.latitude!) <= 90 &&
    Math.abs(p.longitude!) <= 180 &&
    !(p.latitude === 0 && p.longitude === 0)
  );
}

export function distanceMeters(a: Point, b: Point): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(r(a.latitude)) *
      Math.cos(r(b.latitude)) *
      Math.sin(r(b.longitude - a.longitude) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export const etaMinutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

export const fromCoordinates = (c?: [number, number] | null): Point | null =>
  c ? { latitude: c[1], longitude: c[0] } : null;

@Injectable({ providedIn: 'root' })
export class RoutingService {
  private readonly http = inject(HttpClient);
  private readonly cache = new Map<string, Observable<RoadRoute | null>>();

  route(from: Point, to: Point): Observable<RoadRoute | null> {
    if (!isValidPoint(from) || !isValidPoint(to)) return of(null);
    const key = [from.latitude, from.longitude, to.latitude, to.longitude]
      .map((n) => n.toFixed(4))
      .join(',');
    let request = this.cache.get(key);
    if (!request) {
      request = this.http
        .get<ApiResponse<{ route: RoadRoute }>>(`${environment.apiUrl}/geo/route`, {
          params: {
            fromLat: from.latitude,
            fromLng: from.longitude,
            toLat: to.latitude,
            toLng: to.longitude,
          },
        })
        .pipe(
          map((r) => r.data.route),
          catchError(() => {
            this.cache.delete(key);
            return of(null);
          }),
          shareReplay(1),
        );
      if (this.cache.size > 200) this.cache.clear();
      this.cache.set(key, request);
    }
    return request;
  }
}
