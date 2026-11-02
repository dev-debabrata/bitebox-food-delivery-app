import { ChangeDetectionStrategy, Component, effect, inject, input, model, signal, untracked } from '@angular/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ImageUploadComponent } from 'nexprime';
import { errorMessage } from '../../../core/services/api-error';
import { MAX_IMAGE_BYTES, UploadService } from '../../../core/services/upload.service';

/**
 * Image picker (NexPrime <np-image-upload>) that uploads the file to the API
 * and exposes the stored image URL via two-way binding:
 *
 *   <bb-image-upload [(url)]="imageUrl" label="Add a cover photo" />
 *
 * NexPrime previews the chosen file locally (as a data URL) straight away; we
 * then upload the real file and replace the preview with the server URL. Only
 * the server URL is ever written to `url`.
 */
@Component({
  selector: 'bb-image-upload',
  imports: [ImageUploadComponent, MatProgressBarModule],
  templateUrl: './image-upload.html',
  styleUrl: './image-upload.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImageUpload {
  private readonly uploads = inject(UploadService);

  /** Stored image URL (server URL or ''). */
  readonly url = model<string>('');
  readonly label = input('Upload image');
  /** Width / height of the drop zone, e.g. "16 / 9" for covers, 1 for dishes. */
  readonly aspectRatio = input<string | number>('16 / 9');

  protected readonly maxBytes = MAX_IMAGE_BYTES;
  /** What the NexPrime box shows: the stored URL, or a local preview while uploading. */
  protected readonly preview = signal('');
  protected readonly uploading = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    // Keep the box in sync when the form loads or resets the stored URL.
    effect(() => {
      const url = this.url();
      untracked(() => {
        if (!this.uploading()) this.preview.set(url);
      });
    });
  }

  protected onFile(file: File): void {
    const problem = this.uploads.validate(file);
    if (problem) {
      this.error.set(problem);
      this.preview.set(this.url()); // drop the local preview of a file we will not upload
      return;
    }
    this.error.set(null);
    this.uploading.set(true);
    this.uploads.uploadImage(file).subscribe({
      next: (serverUrl) => {
        this.uploading.set(false);
        this.url.set(serverUrl);
        this.preview.set(serverUrl);
      },
      error: (err: unknown) => {
        this.uploading.set(false);
        this.error.set(errorMessage(err, 'Upload failed. Please try again.'));
        this.preview.set(this.url()); // back to the previously stored image
      },
    });
  }

  protected onRemove(): void {
    this.error.set(null);
    this.url.set('');
  }
}
