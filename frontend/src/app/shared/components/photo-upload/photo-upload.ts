import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  model,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { FileUploadComponent, IconComponent } from 'nexprime';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../../core/services/api-error';
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  UploadService,
} from '../../../core/services/upload.service';
import { REVIEW_LIMITS } from '../../models/review.models';

/**
 * Several review photos: NexPrime's uploader for new files (each uploaded as soon as it is chosen),
 * plus thumbnails of photos already saved. `urls` holds every uploaded photo, in order.
 */
@Component({
  selector: 'bb-photo-upload',
  imports: [FileUploadComponent, IconComponent, MatButtonModule],
  templateUrl: './photo-upload.html',
  styleUrl: './photo-upload.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhotoUpload implements OnInit {
  private readonly uploads = inject(UploadService);

  readonly urls = model<string[]>([]);
  readonly max = input<number>(REVIEW_LIMITS.photos);
  readonly label = input('Add photos (optional)');

  protected readonly accept = ACCEPTED_IMAGE_TYPES.join(',');
  protected readonly maxBytes = MAX_IMAGE_BYTES;
  /** Photos saved before this form opened (editing); new uploads are listed by NexPrime itself. */
  protected readonly saved = signal<string[]>([]);
  protected readonly room = computed(() => Math.max(0, this.max() - this.saved().length));
  /** Photos the customer can still add (saved ones plus new uploads count). */
  protected readonly left = computed(() => Math.max(0, this.max() - this.urls().length));
  private readonly byFile = new Map<File, string>();

  /**
   * Upload handler for np-file-upload: the photos upload in parallel and are added in the order
   * chosen. A thrown Error's message is what NexPrime shows (in its role="alert" list).
   */
  protected readonly upload = async (files: File[], progress: (pct: number) => void) => {
    let done = 0;
    const results = await Promise.allSettled(
      files.map(async (file) => {
        const url = await firstValueFrom(this.uploads.uploadImage(file, 'review-images'));
        progress(Math.round((++done / files.length) * 100));
        return url;
      }),
    );
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      this.byFile.set(files[i], r.value);
      this.urls.update((list) => [...list, r.value]);
    });
    const failed = results.findIndex((r) => r.status === 'rejected');
    if (failed >= 0)
      throw new Error(
        `${files[failed].name}: ${errorMessage((results[failed] as PromiseRejectedResult).reason, 'upload failed')}`,
      );
  };

  ngOnInit(): void {
    this.saved.set([...this.urls()]);
  }

  protected removeSaved(url: string): void {
    this.saved.update((list) => list.filter((u) => u !== url));
    this.urls.update((list) => list.filter((u) => u !== url));
  }

  protected removed(file: File): void {
    const url = this.byFile.get(file);
    if (!url) return;
    this.byFile.delete(file);
    this.urls.update((list) => list.filter((u) => u !== url));
  }
}
