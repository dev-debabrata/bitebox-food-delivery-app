import { HttpClient } from '@angular/common/http';
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { inBackground } from './page-loader';

/**
 * Downloads or shows a file the API protects (PDF invoices and statements, CSV reports, KYC
 * documents). A plain link would not carry the access token, so the file is fetched with
 * HttpClient and saved from a blob, named by the API's Content-Disposition header.
 */
@Injectable({ providedIn: 'root' })
export class FileDownloadService {
  private readonly http = inject(HttpClient);
  private readonly document = inject(DOCUMENT);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Resolves once the browser has the file; rejects with a short message on failure. */
  async save(url: string, fallbackName: string): Promise<void> {
    if (!this.browser) return;
    const res = await this.fetch(url);
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
    const href = URL.createObjectURL(res.body!);
    const link = Object.assign(this.document.createElement('a'), { href, download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  /**
   * Shows the file in a new tab. Call it straight from a click: the tab opens at once (so popup
   * blockers allow it) and shows the file when it has arrived.
   */
  async open(url: string): Promise<void> {
    if (!this.browser) return;
    const tab = this.document.defaultView?.open('', '_blank');
    try {
      const href = URL.createObjectURL((await this.fetch(url)).body!);
      if (tab) tab.location.href = href;
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
    } catch (err) {
      tab?.close();
      throw err;
    }
  }

  private async fetch(url: string) {
    try {
      return await firstValueFrom(
        inBackground(this.http.get(url, { responseType: 'blob', observe: 'response' })),
      );
    } catch (err) {
      throw new Error(await messageOf(err));
    }
  }
}

/** The API's error message from a blob error body, or a generic one. */
async function messageOf(err: unknown): Promise<string> {
  const body = (err as { error?: unknown }).error;
  if (body instanceof Blob) {
    try {
      const json = JSON.parse(await body.text()) as { message?: string };
      if (json.message) return json.message;
    } catch {
      /* not JSON */
    }
  }
  return 'Could not download the file. Please try again.';
}
