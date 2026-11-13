import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api.models';

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export type UploadEndpoint = 'images' | 'review-images' | 'avatars';

@Injectable({ providedIn: 'root' })
export class UploadService {
  private readonly http = inject(HttpClient);

  validate(file: File): string | null {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return 'Choose a JPEG, PNG or WebP image';
    if (file.size > MAX_IMAGE_BYTES) return 'Image must be 2 MB or smaller';
    return null;
  }

  /** `images` for partners, `review-images` for customers' review photos, `avatars` for anyone. */
  uploadImage(file: File, endpoint: UploadEndpoint = 'images'): Observable<string> {
    const form = new FormData();
    form.append('image', file);
    return this.http
      .post<ApiResponse<{ url: string }>>(`${environment.baseUrl}/uploads/${endpoint}`, form)
      .pipe(map((res) => res.data.url));
  }
}
