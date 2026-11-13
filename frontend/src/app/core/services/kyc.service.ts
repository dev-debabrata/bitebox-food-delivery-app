import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api.models';
import {
  DocumentStatus,
  KycDocument,
  KycSummary,
  PayoutAccountInput,
} from '../../shared/models/kyc.models';
import { FileDownloadService } from './file-download.service';

/** Partner verification: own documents and bank account; admin review. */
@Injectable({ providedIn: 'root' })
export class KycService {
  private readonly http = inject(HttpClient);
  private readonly files = inject(FileDownloadService);
  private readonly url = `${environment.baseUrl}/kyc`;
  private readonly adminUrl = `${environment.baseUrl}/admin/kyc`;

  summary(): Observable<KycSummary> {
    return this.http.get<ApiResponse<KycSummary>>(this.url).pipe(map((r) => r.data));
  }

  upload(kind: string, file: File, number: string): Observable<KycDocument> {
    const form = new FormData();
    form.append('kind', kind);
    form.append('number', number);
    form.append('file', file);
    return this.http
      .post<ApiResponse<{ document: KycDocument }>>(`${this.url}/documents`, form)
      .pipe(map((r) => r.data.document));
  }

  remove(id: string): Observable<unknown> {
    return this.http.delete(`${this.url}/documents/${encodeURIComponent(id)}`);
  }

  setPayoutAccount(body: PayoutAccountInput): Observable<KycSummary> {
    return this.http
      .put<ApiResponse<KycSummary>>(`${this.url}/payout-account`, body)
      .pipe(map((r) => r.data));
  }

  /** Opens the file in a new tab (fetched with the access token; documents are private). */
  open(doc: KycDocument, admin = false): Promise<void> {
    const base = admin ? `${this.adminUrl}/documents` : `${this.url}/documents`;
    return this.files.open(`${base}/${encodeURIComponent(doc.id)}/file`);
  }

  partner(userId: string): Observable<KycSummary> {
    return this.http
      .get<ApiResponse<KycSummary>>(`${this.adminUrl}/partners/${encodeURIComponent(userId)}`)
      .pipe(map((r) => r.data));
  }

  review(
    id: string,
    status: Exclude<DocumentStatus, 'pending'>,
    note = '',
  ): Observable<KycDocument> {
    return this.http
      .patch<ApiResponse<{ document: KycDocument }>>(
        `${this.adminUrl}/documents/${encodeURIComponent(id)}`,
        { status, note },
      )
      .pipe(map((r) => r.data.document));
  }
}
