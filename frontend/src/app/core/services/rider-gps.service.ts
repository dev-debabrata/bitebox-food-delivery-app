import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { MAX_USABLE_ACCURACY_M } from './geolocation.service';
import { RiderService } from './order-management.service';
import { LocationAck, RealtimeService } from './realtime.service';
import { distanceMeters } from './routing.service';

export interface GpsFix {
  latitude: number;
  longitude: number;
  accuracy: number;
  at: number;
}

const DELIVERY_MIN_GAP_MS = 4_000;
const DELIVERY_MAX_GAP_MS = 15_000;
const DELIVERY_MIN_MOVE_M = 15;
const IDLE_GAP_MS = 60_000;

@Injectable({ providedIn: 'root' })
export class RiderGps {
  private readonly realtime = inject(RealtimeService);
  private readonly rider = inject(RiderService);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly fix = signal<GpsFix | null>(null);
  readonly problem = signal<string | null>(null);
  readonly lastSharedAt = signal<number | null>(null);

  private watchId: number | null = null;
  private delivering = false;
  private lastSent: GpsFix | null = null;
  private sending = false;

  update(online: boolean, delivering: boolean): void {
    if (!online) return this.stop();
    const startedDelivering = delivering && !this.delivering;
    this.delivering = delivering;
    if (startedDelivering && this.fix()) void this.share(this.fix()!, true);
    this.start();
  }

  private start(): void {
    if (!this.browser || this.watchId !== null) return;
    if (!('geolocation' in navigator)) {
      this.problem.set(
        'This device cannot share its location, so customers cannot see you on the map.',
      );
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      ({ coords }) =>
        this.onFix({
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy,
          at: Date.now(),
        }),
      (error) =>
        this.problem.set(
          error.code === error.PERMISSION_DENIED
            ? 'Location permission is off. Allow it in your browser settings so customers can follow the delivery.'
            : 'Your location is unavailable right now (weak GPS?). Updates resume automatically.',
        ),
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
    );
  }

  stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.delivering = false;
    this.problem.set(null);
    this.lastSent = null;
  }

  private onFix(fix: GpsFix): void {
    this.fix.set(fix);
    if (fix.accuracy > MAX_USABLE_ACCURACY_M) {
      this.problem.set(
        "Your GPS signal is weak, so your position isn't being shared. Move into the open or turn on precise location.",
      );
      return;
    }
    this.problem.set(null);
    void this.share(fix);
  }

  private async share(fix: GpsFix, force = false): Promise<void> {
    if (this.sending) return;
    const since = this.lastSent ? fix.at - this.lastSent.at : Infinity;
    const moved = this.lastSent ? distanceMeters(this.lastSent, fix) : Infinity;
    const due = this.delivering
      ? since >= DELIVERY_MAX_GAP_MS ||
        (since >= DELIVERY_MIN_GAP_MS && moved >= DELIVERY_MIN_MOVE_M)
      : since >= IDLE_GAP_MS;
    if (!force && !due) return;

    this.sending = true;
    try {
      const point = {
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracy: Math.round(fix.accuracy),
      };
      let ack: LocationAck = await this.realtime.sendRiderLocation(point);
      if (!ack.ok && ack.error === 'NOT_CONNECTED' && !this.delivering) {
        ack = await firstValueFrom(this.rider.reportLocation(point.latitude, point.longitude)).then(
          () => ({ ok: true }),
          () => ({ ok: false, error: 'NOT_CONNECTED' as const }),
        );
      }
      if (ack.ok) {
        this.lastSent = fix;
        this.lastSharedAt.set(Date.now());
      } else if (ack.error === 'NOT_CONNECTED' && this.delivering) {
        this.problem.set('Reconnecting… your position will be shared again in a moment.');
      }
    } finally {
      this.sending = false;
    }
  }
}
