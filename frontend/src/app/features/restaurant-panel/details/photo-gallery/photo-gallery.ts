import { ChangeDetectionStrategy, Component, computed, model } from '@angular/core';
import { ImageUpload } from '../../../../shared/components/image-upload/image-upload';

const MAX_PHOTOS = 8;

/** Up to 8 extra photos of the restaurant (food, inside, outside), shown on its page. */
@Component({
  selector: 'bb-photo-gallery',
  imports: [ImageUpload],
  templateUrl: './photo-gallery.html',
  styleUrl: './photo-gallery.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhotoGallery {
  readonly photos = model<string[]>([]);
  protected readonly canAdd = computed(() => this.photos().length < MAX_PHOTOS);
  protected readonly max = MAX_PHOTOS;

  /** A tile changed: a new URL replaces the photo, an empty one removes it. */
  protected set(index: number, url: string): void {
    this.photos.update((list) =>
      url ? list.map((p, i) => (i === index ? url : p)) : list.filter((_, i) => i !== index),
    );
  }

  protected add(url: string): void {
    if (url) this.photos.update((list) => [...list, url]);
  }
}
