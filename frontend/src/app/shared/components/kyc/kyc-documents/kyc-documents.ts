import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormRoot, TreeValidationResult, form } from '@angular/forms/signals';
import { ButtonComponent, IconComponent } from 'nexprime';
import { firstValueFrom } from 'rxjs';
import { errorMessage, fieldErrors } from '../../../../core/services/api-error';
import { KycService } from '../../../../core/services/kyc.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { serverErrors, shownError } from '../../../forms/form-errors';
import { NP_FORM_FIELDS } from '../../../forms/np-form-fields';
import {
  DOCUMENT_LABEL,
  DOCUMENT_TONE,
  KycDocument,
  KycSummary,
  NUMBER_HINTS,
} from '../../../models/kyc.models';

const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * A partner's verification documents: what is needed, each one's review status, and an upload
 * form (number + file). Files are private: "View" fetches them with the access token.
 */
@Component({
  selector: 'bb-kyc-documents',
  imports: [DatePipe, FormRoot, NP_FORM_FIELDS, ButtonComponent, IconComponent],
  templateUrl: './kyc-documents.html',
  styleUrl: './kyc-documents.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KycDocuments {
  private readonly api = inject(KycService);
  private readonly notify = inject(NotificationService);

  readonly summary = input.required<KycSummary>();
  /** A document was uploaded or removed: the parent reloads the summary. */
  readonly changed = output<void>();

  protected readonly accept = ACCEPT;
  protected readonly tone = DOCUMENT_TONE;
  protected readonly statusLabel = DOCUMENT_LABEL;
  protected readonly hints = NUMBER_HINTS;
  protected readonly shownError = shownError;

  /** The checklist, with each row's uploaded document (if any). */
  protected readonly rows = computed(() => {
    const docs = new Map(this.summary().documents.map((d) => [d.kind, d]));
    return this.summary().checklist.map((item) => ({ ...item, doc: docs.get(item.kind) ?? null }));
  });

  protected readonly editing = signal<string | null>(null);
  protected readonly file = signal<File | null>(null);
  protected readonly fileError = signal<string | null>(null);
  protected readonly model = signal({ number: '' });
  protected readonly form = form(this.model, () => undefined, {
    submission: { action: () => this.upload() },
  });

  protected edit(kind: string | null): void {
    this.editing.set(kind);
    this.file.set(null);
    this.fileError.set(null);
    this.form().reset({ number: '' });
  }

  protected pick(event: Event): void {
    const chosen = (event.target as HTMLInputElement).files?.[0] ?? null;
    this.fileError.set(chosen && chosen.size > MAX_BYTES ? 'Choose a file of 5 MB or less' : null);
    this.file.set(chosen);
  }

  private async upload(): Promise<TreeValidationResult> {
    const kind = this.editing();
    const file = this.file();
    if (!kind) return undefined;
    if (!file) {
      this.fileError.set('Choose a PDF or a photo of the document');
      return undefined;
    }
    if (this.fileError()) return undefined;
    try {
      await firstValueFrom(this.api.upload(kind, file, this.model().number.trim()));
      this.notify.success('Document uploaded. We will review it soon.');
      this.edit(null);
      this.changed.emit();
      return undefined;
    } catch (err) {
      const fields = fieldErrors(err);
      if (!fields.length) this.notify.error(errorMessage(err));
      return serverErrors(this.form, fields);
    }
  }

  protected view(doc: KycDocument): void {
    this.api.open(doc).catch((err: Error) => this.notify.error(err.message));
  }
}
