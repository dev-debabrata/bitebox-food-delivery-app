import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type * as Leaflet from 'leaflet';
import { environment } from '../../../../environments/environment';
import { UNRELIABLE_ACCURACY_M } from '../../../core/services/geolocation.service';

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Centre of India, shown zoomed out when nothing is pinned yet. */
const FALLBACK: LatLng = { latitude: 22.35, longitude: 78.67 };

/**
 * Map with a draggable pin (Leaflet + OpenStreetMap tiles).
 * - Drag the pin or tap the map to move it; `moved` emits the new point.
 * - Changing `latitude`/`longitude` from outside (GPS, search) moves the pin.
 * Leaflet is loaded only in the browser, so this is safe with SSR.
 */
@Component({
  selector: 'bb-map-picker',
  templateUrl: './map-picker.html',
  styleUrl: './map-picker.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapPicker {
  readonly latitude = input<number | null>(null);
  readonly longitude = input<number | null>(null);
  /** Shows a circle of this radius (metres) around the pin, e.g. GPS accuracy. */
  readonly accuracyMeters = input<number | null>(null);
  readonly moved = output<LatLng>();

  protected readonly loadError = signal<string | null>(null);
  protected readonly ready = signal(false);
  private readonly container = viewChild.required<ElementRef<HTMLDivElement>>('map');

  private L?: typeof Leaflet;
  private map?: Leaflet.Map;
  private marker?: Leaflet.Marker;
  private circle?: Leaflet.Circle;
  private resizeObserver?: ResizeObserver;

  constructor() {
    afterNextRender(() => void this.init());
    inject(DestroyRef).onDestroy(() => {
      this.resizeObserver?.disconnect();
      this.map?.remove();
    });

    // Follow position changes made outside the map (GPS button, search result).
    effect(() => {
      const lat = this.latitude();
      const lng = this.longitude();
      const accuracy = this.accuracyMeters();
      if (!this.ready() || lat === null || lng === null) return;
      this.placePin({ latitude: lat, longitude: lng }, accuracy);
    });
  }

  private async init(): Promise<void> {
    try {
      const mod = await import('leaflet');
      const L = (this.L = ((mod as { default?: typeof Leaflet }).default ?? mod) as typeof Leaflet);
      const start = this.hasPoint() ? { latitude: this.latitude()!, longitude: this.longitude()! } : FALLBACK;
      this.map = L.map(this.container().nativeElement, { zoomControl: true, attributionControl: true }).setView(
        [start.latitude, start.longitude],
        this.hasPoint() ? 17 : 5,
      );
      L.tileLayer(environment.map.tileUrl, { maxZoom: environment.map.maxZoom, attribution: environment.map.attribution }).addTo(this.map);

      // Clicking/tapping the map moves the pin there.
      this.map.on('click', (event: Leaflet.LeafletMouseEvent) => {
        const point = { latitude: event.latlng.lat, longitude: event.latlng.lng };
        this.placePin(point, null, false);
        this.moved.emit(point);
      });
      if (this.hasPoint()) this.placePin(start, this.accuracyMeters());
      // The map is often created while a dialog is still animating open, so its
      // first measured size is wrong (tiles only fill part of the box). Re-measure
      // whenever the container's size changes.
      this.resizeObserver = new ResizeObserver(() => this.map?.invalidateSize());
      this.resizeObserver.observe(this.container().nativeElement);
      this.ready.set(true);
    } catch {
      this.loadError.set('The map could not be loaded. You can still enter coordinates manually.');
    }
  }

  private hasPoint(): boolean {
    return this.latitude() !== null && this.longitude() !== null;
  }

  private placePin(point: LatLng, accuracy: number | null, recenter = true): void {
    const L = this.L;
    const map = this.map;
    if (!L || !map) return;
    const latLng = L.latLng(point.latitude, point.longitude);

    if (!this.marker) {
      // A CSS pin avoids Leaflet's default image assets (which need extra build config).
      const icon = L.divIcon({ className: 'bb-map-pin', html: '<span></span>', iconSize: [30, 42], iconAnchor: [15, 42] });
      this.marker = L.marker(latLng, { draggable: true, icon, keyboard: true, title: 'Delivery location (drag to adjust)' }).addTo(map);
      this.marker.on('dragend', () => {
        const p = this.marker!.getLatLng();
        this.circle?.remove();
        this.circle = undefined;
        this.moved.emit({ latitude: p.lat, longitude: p.lng });
      });
    } else if (!this.marker.getLatLng().equals(latLng, 1e-7)) {
      this.marker.setLatLng(latLng);
    }

    // Show the uncertainty circle only when it is meaningful. A huge radius
    // (rough network guess) would zoom the map out to a whole country.
    const showCircle = !!accuracy && accuracy <= UNRELIABLE_ACCURACY_M;
    this.circle?.remove();
    this.circle = showCircle ? L.circle(latLng, { radius: accuracy!, color: '#e89a0c', weight: 1, fillOpacity: 0.12 }).addTo(map) : undefined;

    if (recenter) {
      if (this.circle && accuracy! > 150) map.fitBounds(this.circle.getBounds(), { maxZoom: 17 });
      else map.setView(latLng, Math.max(map.getZoom(), 16));
    }
  }
}
