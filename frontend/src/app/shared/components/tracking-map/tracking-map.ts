import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import type * as Leaflet from 'leaflet';
import { environment } from '../../../../environments/environment';
import { Point, isValidPoint } from '../../../core/services/routing.service';

type MarkerKind = 'restaurant' | 'home' | 'rider';
/** NexPrime icon per marker, drawn inline (markers are plain Leaflet HTML, not Angular templates). */
const ICON: Record<MarkerKind, string> = {
  restaurant: 'store',
  home: 'house',
  rider: 'bike',
};
const LABEL: Record<MarkerKind, string> = {
  restaurant: 'Restaurant',
  home: 'Delivery address',
  rider: 'Rider',
};
/** Rider marker glides to each new position over this long. */
const GLIDE_MS = 900;

/**
 * Read-only delivery map (Leaflet + OpenStreetMap tiles): restaurant, drop-off
 * and the rider's live position, with the road route (solid) or, when no road
 * route is available, a dashed straight line between the two stops.
 *
 * - Invalid coordinates are ignored rather than drawn at 0,0.
 * - The view fits everything once, then pans only when the rider leaves it,
 *   so people can zoom and pan without the map jumping back.
 * - Leaflet loads in the browser only (SSR-safe); a load failure shows a message.
 */
@Component({
  selector: 'bb-tracking-map',
  templateUrl: './tracking-map.html',
  styleUrl: './tracking-map.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackingMap {
  readonly restaurant = input<Point | null>(null);
  readonly destination = input<Point | null>(null);
  readonly rider = input<Point | null>(null);
  /** Rider position is old: shown greyed out. */
  readonly riderStale = input(false);
  /** Road route to draw. When null, a dashed straight line joins `lineFrom` and the destination. */
  readonly route = input<Point[] | null>(null);
  /** Start of the dashed fallback line (defaults to the restaurant). */
  readonly lineFrom = input<Point | null>(null);
  /** Accessible summary of what the map shows (the same facts are also given as text nearby). */
  readonly label = input('Delivery map');

  protected readonly loadError = signal<string | null>(null);
  private readonly ready = signal(false);
  private readonly container = viewChild.required<ElementRef<HTMLDivElement>>('map');

  private L?: typeof Leaflet;
  private map?: Leaflet.Map;
  private readonly markers: Partial<Record<MarkerKind, Leaflet.Marker>> = {};
  /** The marker icons' SVG markup, loaded once from the app's own /icons folder. */
  private svgs: Partial<Record<MarkerKind, string>> = {};
  private line?: Leaflet.Polyline;
  private fitted = false;
  private glide?: number;
  private resizeObserver?: ResizeObserver;

  // Separate so the route line (which depends on the fixed stops) is not rebuilt on every rider move.
  private readonly stops = computed(() => ({
    restaurant: isValidPoint(this.restaurant()) ? this.restaurant() : null,
    home: isValidPoint(this.destination()) ? this.destination() : null,
  }));
  private readonly riderPoint = computed(() => (isValidPoint(this.rider()) ? this.rider() : null));

  constructor() {
    afterNextRender(() => void this.init());
    inject(DestroyRef).onDestroy(() => {
      if (this.glide) cancelAnimationFrame(this.glide);
      this.resizeObserver?.disconnect();
      this.map?.remove();
    });

    effect(() => {
      const points = { ...this.stops(), rider: this.riderPoint() };
      const stale = this.riderStale();
      if (!this.ready()) return;
      this.place('restaurant', points.restaurant);
      this.place('home', points.home);
      this.place('rider', points.rider, stale);
      this.keepInView(points);
    });

    effect(() => {
      if (!this.ready()) return;
      const route = (this.route() ?? []).filter(isValidPoint);
      if (route.length > 1) return this.drawLine(route, true);
      // No road route: dashed straight line. Only this branch reads lineFrom (often the moving rider).
      const from = isValidPoint(this.lineFrom()) ? this.lineFrom() : this.stops().restaurant;
      const to = this.stops().home;
      this.drawLine(from && to ? [from, to] : [], false);
    });
  }

  private async init(): Promise<void> {
    try {
      const [mod] = await Promise.all([import('leaflet'), this.loadMarkerIcons()]);
      const L = (this.L = ((mod as { default?: typeof Leaflet }).default ?? mod) as typeof Leaflet);
      this.map = L.map(this.container().nativeElement, {
        zoomControl: true,
        attributionControl: true,
        scrollWheelZoom: false,
      });
      this.map.setView([22.35, 78.67], 5);
      L.tileLayer(environment.map.tileUrl, {
        maxZoom: environment.map.maxZoom,
        attribution: environment.map.attribution,
      })
        .on('tileerror', () =>
          this.loadError.set(
            'Some map tiles could not be loaded. Positions below are still accurate.',
          ),
        )
        .addTo(this.map);
      this.resizeObserver = new ResizeObserver(() => this.map?.invalidateSize());
      this.resizeObserver.observe(this.container().nativeElement);
      this.ready.set(true);
    } catch {
      this.loadError.set(
        'The map could not be loaded. Order details and updates below still work.',
      );
    }
  }

  private async loadMarkerIcons(): Promise<void> {
    const entries = await Promise.all(
      (Object.keys(ICON) as MarkerKind[]).map(async (kind) => {
        const res = await fetch(`icons/${ICON[kind]}.svg`).catch(() => null);
        return [kind, res?.ok ? await res.text() : ''] as const;
      }),
    );
    this.svgs = Object.fromEntries(entries);
  }

  private place(kind: MarkerKind, point: Point | null, stale = false): void {
    const L = this.L!;
    const existing = this.markers[kind];
    if (!point) {
      existing?.remove();
      delete this.markers[kind];
      return;
    }
    const target = L.latLng(point.latitude, point.longitude);
    if (!existing) {
      const icon = L.divIcon({
        className: `bb-track-marker bb-track-${kind}`,
        html: `<span class="bb-track-icon" aria-hidden="true">${this.svgs[kind] ?? ''}</span>`,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
      });
      this.markers[kind] = L.marker(target, {
        icon,
        title: LABEL[kind],
        keyboard: false,
        zIndexOffset: kind === 'rider' ? 1000 : 0,
      }).addTo(this.map!);
    } else if (kind === 'rider') {
      this.glideTo(existing, target);
    } else if (!existing.getLatLng().equals(target, 1e-7)) {
      existing.setLatLng(target);
    }
    if (kind === 'rider') this.markers.rider?.getElement()?.classList.toggle('is-stale', stale);
  }

  /** Smoothly moves the rider marker instead of jumping. */
  private glideTo(marker: Leaflet.Marker, target: Leaflet.LatLng): void {
    if (this.glide) cancelAnimationFrame(this.glide);
    const start = marker.getLatLng();
    const began = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / GLIDE_MS);
      marker.setLatLng([
        start.lat + (target.lat - start.lat) * t,
        start.lng + (target.lng - start.lng) * t,
      ]);
      this.glide = t < 1 ? requestAnimationFrame(step) : undefined;
    };
    this.glide = requestAnimationFrame(step);
  }

  private drawLine(path: Point[], isRoad: boolean): void {
    this.line?.remove();
    this.line = undefined;
    if (path.length < 2) return;
    this.line = this.L!.polyline(
      path.map((p) => [p.latitude, p.longitude] as [number, number]),
      isRoad
        ? { color: '#2e1a3d', weight: 5, opacity: 0.8 }
        : { color: '#6b5a78', weight: 3, opacity: 0.7, dashArray: '6 8' },
    ).addTo(this.map!);
    this.line.bringToBack();
  }

  /** Fit everything once; afterwards only pan if the rider drives out of view. */
  private keepInView(points: {
    restaurant: Point | null;
    home: Point | null;
    rider: Point | null;
  }): void {
    const L = this.L!;
    const all = [points.restaurant, points.home, points.rider].filter((p): p is Point => !!p);
    if (all.length === 0) return;
    if (!this.fitted) {
      this.fitted = true;
      if (all.length === 1) this.map!.setView([all[0].latitude, all[0].longitude], 15);
      else
        this.map!.fitBounds(L.latLngBounds(all.map((p) => [p.latitude, p.longitude])), {
          padding: [36, 36],
          maxZoom: 16,
        });
      return;
    }
    if (
      points.rider &&
      !this.map!.getBounds().pad(-0.1).contains([points.rider.latitude, points.rider.longitude])
    ) {
      this.map!.panTo([points.rider.latitude, points.rider.longitude]);
    }
  }
}
