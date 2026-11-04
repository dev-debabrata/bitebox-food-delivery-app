import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from 'nexprime';

export interface PhotoViewerData {
  images: string[];
  index?: number;
  /** Who or what the photos belong to, e.g. "Debabrata D." (used in the alt text and title). */
  caption?: string;
}

const MIN = 1;
const MAX = 4;
const STEP = 0.5;

/**
 * Full-size review photos: previous/next, zoom (buttons, wheel, double-click, pinch) and drag to pan
 * when zoomed. Keyboard: ←/→ change photo, + / − zoom, 0 resets, Esc closes.
 */
@Component({
  selector: 'bb-photo-viewer',
  imports: [MatDialogModule, MatButtonModule, IconComponent],
  templateUrl: './photo-viewer.html',
  styleUrl: './photo-viewer.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The viewer is modal, so its shortcuts listen on the document (focus may sit on the dialog container).
  host: { '(document:keydown)': 'onKey($event)' },
})
export class PhotoViewer {
  protected readonly data = inject<PhotoViewerData>(MAT_DIALOG_DATA);

  protected readonly index = signal(
    Math.min(Math.max(this.data.index ?? 0, 0), this.data.images.length - 1),
  );
  protected readonly scale = signal(1);
  protected readonly x = signal(0);
  protected readonly y = signal(0);
  protected readonly dragging = signal(false);

  protected readonly src = computed(() => this.data.images[this.index()]);
  protected readonly many = this.data.images.length > 1;
  protected readonly zoomed = computed(() => this.scale() > MIN);
  protected readonly percent = computed(() => Math.round(this.scale() * 100));
  protected readonly transform = computed(
    () => `translate(${this.x()}px, ${this.y()}px) scale(${this.scale()})`,
  );
  protected readonly alt = computed(
    () =>
      `Photo ${this.index() + 1} of ${this.data.images.length}` +
      (this.data.caption ? ` from ${this.data.caption}` : ''),
  );
  protected readonly canZoomIn = computed(() => this.scale() < MAX);

  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchStart: { distance: number; scale: number } | null = null;
  private last: { x: number; y: number } | null = null;
  private stage: HTMLElement | null = null;

  protected go(step: number): void {
    const n = this.data.images.length;
    this.index.set((this.index() + step + n) % n);
    this.reset();
  }

  protected zoom(by: number): void {
    this.setScale(this.scale() + by);
  }

  protected reset(): void {
    this.scale.set(MIN);
    this.x.set(0);
    this.y.set(0);
  }

  protected toggleZoom(): void {
    if (this.zoomed()) this.reset();
    else this.setScale(2);
  }

  protected onWheel(event: WheelEvent): void {
    event.preventDefault();
    this.setScale(this.scale() * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
  }

  protected onPointerDown(event: PointerEvent): void {
    this.stage = event.currentTarget as HTMLElement;
    this.stage.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2) {
      this.pinchStart = { distance: this.spread(), scale: this.scale() };
      this.last = null;
    } else {
      this.last = { x: event.clientX, y: event.clientY };
      this.dragging.set(this.zoomed());
    }
  }

  protected onPointerMove(event: PointerEvent): void {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pinchStart && this.pointers.size === 2) {
      this.setScale(this.pinchStart.scale * (this.spread() / this.pinchStart.distance));
      return;
    }
    if (this.last && this.zoomed()) {
      this.pan(event.clientX - this.last.x, event.clientY - this.last.y);
      this.last = { x: event.clientX, y: event.clientY };
    }
  }

  protected onPointerUp(event: PointerEvent): void {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinchStart = null;
    if (!this.pointers.size) {
      this.last = null;
      this.dragging.set(false);
    }
  }

  protected onKey(event: KeyboardEvent): void {
    const actions: Record<string, () => void> = {
      ArrowLeft: () => this.many && this.go(-1),
      ArrowRight: () => this.many && this.go(1),
      '+': () => this.zoom(STEP),
      '=': () => this.zoom(STEP),
      '-': () => this.zoom(-STEP),
      '0': () => this.reset(),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  }

  protected readonly step = STEP;

  private setScale(value: number): void {
    const scale = Math.min(MAX, Math.max(MIN, Math.round(value * 100) / 100));
    this.scale.set(scale);
    if (scale === MIN) {
      this.x.set(0);
      this.y.set(0);
    } else {
      this.pan(0, 0); // keep the photo inside the frame at the new size
    }
  }

  /** Moves the zoomed photo, never further than its edges. */
  private pan(dx: number, dy: number): void {
    const rect = this.stage?.getBoundingClientRect();
    const limitX = rect ? (rect.width * (this.scale() - 1)) / 2 : Infinity;
    const limitY = rect ? (rect.height * (this.scale() - 1)) / 2 : Infinity;
    const clamp = (v: number, limit: number) => Math.min(limit, Math.max(-limit, v));
    this.x.set(clamp(this.x() + dx, limitX));
    this.y.set(clamp(this.y() + dy, limitY));
  }

  private spread(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}

export function openPhotoViewer(dialog: MatDialog, data: PhotoViewerData): void {
  dialog.open<PhotoViewer, PhotoViewerData>(PhotoViewer, {
    data,
    // Full screen: the photo gets the whole viewport.
    width: '100vw',
    height: '100dvh',
    maxWidth: '100vw',
    maxHeight: '100dvh',
    panelClass: 'bb-photo-viewer-panel',
    backdropClass: 'bb-photo-viewer-backdrop',
    autoFocus: 'dialog',
  });
}
